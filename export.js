#!/usr/bin/env node

import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";

const MAX_RETRIES = 3;
const TIMEOUT = 30000; // 30 seconds
const RATE_LIMIT_DELAY = 3000; // 3 seconds between requests (20 requests/minute, well under 180/minute limit)
const BATCH_SIZE = 10;
const FULL_SYNC_EMPTY_DAYS_THRESHOLD = 10; // Stop after 10 consecutive days with no data

console.log("🚀 Starting lifelog export script...");

// Zod schemas for API response validation
console.log("📋 Setting up data validation schemas...");
const LifelogContentSchema = z.object({
  type: z.enum(["heading1", "heading2", "heading3", "blockquote", "text"]),
  content: z.string(),
  startTime: z.string().optional(),
  speakerName: z.string().optional(),
});

const LifelogSchema = z.object({
  id: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  contents: z.array(LifelogContentSchema).optional(),
});

const LifelogsResponseSchema = z.object({
  data: z.object({ lifelogs: z.array(LifelogSchema) }),
  meta: z
    .object({
      lifelogs: z
        .object({
          nextCursor: z.string().nullable().optional(),
          count: z.number().optional(),
        })
        .optional(),
      nextCursor: z.string().nullable().optional(),
    })
    .optional(),
  nextCursor: z.string().nullable().optional(),
});

// Ensure the API key is provided
console.log("🔑 Checking for API key...");
const apiKey = process.env.LIMITLESS_API_KEY;
if (!apiKey) {
  console.error("❌ Error: LIMITLESS_API_KEY environment variable is required");
  process.exit(1);
}
console.log("✅ API key found");

// Parse command line arguments
console.log("⚙️ Parsing command line arguments...");
const args = process.argv.slice(2);
const isFullSync = args.includes("--full-sync");
console.log(`🔄 Sync mode: ${isFullSync ? "Full sync" : "Incremental sync"}`);

async function sleep(ms) {
  console.log(`😴 Sleeping for ${ms}ms...`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDirectoryExists(dirPath) {
  try {
    console.log(`📁 Checking if directory exists: ${dirPath}`);
    await fs.access(dirPath);
    console.log(`✅ Directory already exists: ${dirPath}`);
  } catch {
    console.log(`📁 Creating directory: ${dirPath}`);
    await fs.mkdir(dirPath, { recursive: true });
    console.log(`✅ Directory created: ${dirPath}`);
  }
}

async function saveSyncState(state) {
  console.log("💾 Saving sync state...");
  const statePath = path.join(process.cwd(), "data", ".sync-state.json");
  // Convert Set to Array for JSON serialization
  const serializedState = {
    ...state,
    emptyDays: Array.from(state.emptyDays || []),
  };
  await fs.writeFile(statePath, JSON.stringify(serializedState, null, 2));
  console.log("✅ Sync state saved");
}

async function loadSyncState() {
  try {
    console.log("📂 Loading sync state...");
    const statePath = path.join(process.cwd(), "data", ".sync-state.json");
    const content = await fs.readFile(statePath, "utf-8");
    const state = JSON.parse(content);
    // Ensure emptyDays exists for backwards compatibility
    if (!state.emptyDays) {
      state.emptyDays = new Set();
    } else if (Array.isArray(state.emptyDays)) {
      state.emptyDays = new Set(state.emptyDays);
    }
    console.log("✅ Sync state loaded");
    return state;
  } catch {
    console.log("📂 No existing sync state found, creating new one");
    return { lastSyncTime: null, failedAttempts: [], emptyDays: new Set() };
  }
}

async function findLatestTranscriptionDate(dataDir) {
  try {
    console.log(`🔍 Scanning for latest transcription date in: ${dataDir}`);
    const files = await fs.readdir(dataDir);
    const markdownFiles = files.filter((file) => file.endsWith(".md"));
    console.log(`📄 Found ${markdownFiles.length} markdown files`);

    let latestDate = null;

    for (const file of markdownFiles) {
      // Extract date from filename (format: YYYY-MM-DD.md) - no need to read file content
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (dateMatch) {
        const fileDate = dateMatch[1];
        if (!latestDate || fileDate > latestDate) {
          latestDate = fileDate;
        }
      }
    }

    console.log(`📅 Latest transcription date: ${latestDate || "None"}`);
    return latestDate;
  } catch (error) {
    console.warn(
      "⚠️ Could not scan data directory for transcriptions:",
      error.message
    );
    return null;
  }
}

async function findEarliestTranscriptionDate(dataDir) {
  try {
    console.log(`🔍 Scanning for earliest transcription date in: ${dataDir}`);
    const files = await fs.readdir(dataDir);
    const markdownFiles = files.filter((file) => file.endsWith(".md"));
    console.log(`📄 Found ${markdownFiles.length} markdown files`);

    let earliestDate = null;

    for (const file of markdownFiles) {
      // Extract date from filename (format: YYYY-MM-DD.md) - no need to read file content
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (dateMatch) {
        const fileDate = dateMatch[1];
        if (!earliestDate || fileDate < earliestDate) {
          earliestDate = fileDate;
        }
      }
    }

    console.log(`📅 Earliest transcription date: ${earliestDate || "None"}`);
    return earliestDate;
  } catch (error) {
    console.warn(
      "⚠️ Could not scan data directory for transcriptions:",
      error.message
    );
    return null;
  }
}

function hasEmptyDaysNeedingResync(syncState, lastSyncDate, safeDateStr) {
  console.log("🔍 Checking for empty days that need resyncing...");
  // Check if there are any days between safe date and last sync date that only have empty data
  const startDate = new Date(safeDateStr);
  const endDate = new Date(lastSyncDate);

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    if (syncState.emptyDays && syncState.emptyDays.has(dateStr)) {
      console.log(`🔄 Found empty day that needs resyncing: ${dateStr}`);
      return true;
    }
  }
  console.log("✅ No empty days need resyncing");
  return false;
}

async function processLifelogs(lifelogs, dataDir, syncState = null) {
  console.log(`🔄 Processing ${lifelogs.length} lifelogs...`);

  // Group lifelogs by date
  const lifelogsByDate = {};
  for (const lifelog of lifelogs) {
    console.log("📝 Processing lifelog:", {
      id: lifelog.id,
      startTime: lifelog.startTime,
      endTime: lifelog.endTime,
    });
    const date = new Date(lifelog.startTime).toISOString().split("T")[0];
    if (!lifelogsByDate[date]) {
      lifelogsByDate[date] = [];
    }
    lifelogsByDate[date].push(lifelog);
  }

  console.log(
    `📅 Grouped lifelogs into ${Object.keys(lifelogsByDate).length} dates`
  );

  // Save each day's lifelogs as markdown
  for (const [date, logs] of Object.entries(lifelogsByDate)) {
    console.log(
      `📝 Creating markdown for date: ${date} (${logs.length} lifelogs)`
    );
    const markdownFilePath = path.join(dataDir, `${date}.md`);
    await ensureDirectoryExists(path.dirname(markdownFilePath));
    await createMarkdownFile(markdownFilePath, logs);

    // Remove this date from empty days since we now have real data
    if (syncState && syncState.emptyDays) {
      syncState.emptyDays.delete(date);
      console.log(`✅ Removed ${date} from empty days list`);
    }
  }

  console.log("✅ Finished processing all lifelogs");
}

async function createMarkdownFile(filePath, lifelogs) {
  try {
    console.log(`📝 Creating markdown file: ${filePath}`);

    // Combine all content into a single markdown string
    const markdownContent = lifelogs
      .map((lifelog) => {
        if (!lifelog.contents || !Array.isArray(lifelog.contents)) return "";

        return lifelog.contents
          .map((item) => {
            switch (item.type) {
              case "heading1":
                return `# ${item.content}\n`;
              case "heading2":
                return `## ${item.content}\n`;
              case "heading3":
                return `### ${item.content}\n`;
              case "blockquote":
                const speaker = item.speakerName || "Unknown";
                const time = new Date(item.startTime).toLocaleTimeString();
                return `> **${speaker}** (${time}): ${item.content}\n`;
              default:
                return `${item.content}\n`;
            }
          })
          .join("\n");
      })
      .filter((content) => content.trim())
      .join("\n\n");

    // Write to file
    await fs.writeFile(filePath, markdownContent);
    console.log(`✅ Created markdown file: ${filePath}`);
  } catch (error) {
    console.error(
      `❌ Error creating markdown file ${filePath}:`,
      error.message
    );
    throw error; // Propagate error for better error handling
  }
}

async function fetchLifelogs(apiUrl, params, retryCount = 0) {
  try {
    console.log(
      `🌐 Fetching lifelogs from API (attempt ${retryCount + 1}/${
        MAX_RETRIES + 1
      })...`
    );
    console.log(`📡 API URL: ${apiUrl}/v1/lifelogs`);
    console.log(`🔧 Parameters:`, params);

    const response = await axios.get(`${apiUrl}/v1/lifelogs`, {
      headers: { "X-API-Key": apiKey },
      params,
      timeout: TIMEOUT,
    });

    console.log(`📥 Received response with status: ${response.status}`);

    // Validate response structure with Zod
    try {
      console.log("🔍 Validating API response structure...");
      const validatedData = LifelogsResponseSchema.parse(response.data);
      console.log("✅ API response validation successful");
      return validatedData;
    } catch (validationError) {
      console.error("❌ API Response validation failed:", validationError);
      console.error(
        "❌ Invalid response:",
        JSON.stringify(response.data, null, 2)
      );
      throw new Error("Invalid API response structure");
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 429) {
        // Rate limit hit, wait longer
        console.log("⏰ Rate limit hit, waiting 60 seconds...");
        await sleep(60000);
        return fetchLifelogs(apiUrl, params, retryCount);
      }

      if (retryCount < MAX_RETRIES) {
        console.log(
          `🔄 Request failed, retrying (${retryCount + 1}/${MAX_RETRIES})...`
        );
        await sleep(1000 * Math.pow(2, retryCount)); // Exponential backoff
        return fetchLifelogs(apiUrl, params, retryCount + 1);
      }
    }
    console.error("❌ Request failed after all retries");
    throw error;
  }
}

async function exportLifelogs(fullSync = false) {
  try {
    console.log("🚀 Starting lifelog export...");

    // Create data directory if it doesn't exist
    const dataDir = path.join(process.cwd(), "data");
    console.log(`📁 Data directory: ${dataDir}`);
    await ensureDirectoryExists(dataDir);

    const apiUrl = process.env.LIMITLESS_API_URL || "https://api.limitless.ai";
    console.log(`🌐 API URL: ${apiUrl}`);

    console.log("📂 Loading sync state...");
    let syncState = await loadSyncState();

    // Find the latest transcription file to determine where to stop syncing
    console.log("🔍 Finding latest transcription date...");
    const latestTranscriptionDate = await findLatestTranscriptionDate(dataDir);

    // Start from today and go backward until the latest existing file
    const today = new Date().toISOString().split("T")[0];
    console.log(`📅 Today's date: ${today}`);
    let endDate = null; // This is where we stop syncing (going backward)

    if (fullSync) {
      // In full sync mode, find the earliest existing file to use as end date
      console.log("🔄 Full sync mode - finding earliest transcription date...");
      const earliestTranscriptionDate = await findEarliestTranscriptionDate(
        dataDir
      );
      if (earliestTranscriptionDate) {
        endDate = earliestTranscriptionDate;
        console.log(
          `🔄 Starting full sync from today (${today}) going backward until earliest existing file (${endDate})`
        );
      } else {
        console.log(
          `🔄 Starting full sync from today (${today}) going backward until no data for ${FULL_SYNC_EMPTY_DAYS_THRESHOLD} consecutive days`
        );
      }
    } else if (latestTranscriptionDate) {
      // Stop at the latest existing file date
      endDate = latestTranscriptionDate;
      console.log(
        `📤 Starting sync from today (${today}) going backward until latest existing file (${endDate})`
      );
    } else {
      // If no existing files, sync the last 30 days as fallback
      const fallbackDate = new Date();
      fallbackDate.setDate(fallbackDate.getDate() - 30);
      endDate = fallbackDate.toISOString().split("T")[0];
      console.log(
        `📤 No existing files found, syncing from today (${today}) backward 30 days until ${endDate}`
      );
    }

    // Check if we're already up to date (skip this check in full sync mode)
    if (!fullSync && syncState.lastSyncTime) {
      const lastSyncDate = new Date(syncState.lastSyncTime)
        .toISOString()
        .split("T")[0];
      console.log(`🕐 Last sync time: ${lastSyncDate}`);
      if (lastSyncDate >= today) {
        console.log(
          `✅ Already synced up to ${lastSyncDate}, which covers today ${today}`
        );
        return;
      }
    }

    // Sync from today going backward (descending) until we reach the end date or empty threshold
    console.log("🔄 Starting sync loop...");
    let totalProcessed = 0;
    let consecutiveEmptyDays = 0; // Track consecutive days with no data for full sync
    let batchCount = 0;

    // For full sync, query dates one by one going backward
    if (fullSync) {
      console.log("🔄 Full sync mode - querying dates one by one...");

      // Start from today and go backward
      let currentDate = new Date(today);

      while (currentDate.toISOString().split("T")[0] >= endDate) {
        const dateStr = currentDate.toISOString().split("T")[0];
        batchCount++;
        console.log(
          `\n🔄 Processing date: ${dateStr} (batch ${batchCount})...`
        );

        const params = {
          limit: BATCH_SIZE.toString(),
          includeMarkdown: "true",
          includeHeadings: "true",
          direction: "desc",
          date: dateStr,
        };

        try {
          console.log("🌐 Fetching lifelogs from API...");
          const response = await fetchLifelogs(apiUrl, params);
          const lifelogs = response.data.lifelogs;

          if (!lifelogs || lifelogs.length === 0) {
            console.log(`📭 No data for date ${dateStr}`);
            consecutiveEmptyDays++;
            console.log(
              `📅 Consecutive empty days: ${consecutiveEmptyDays}/${FULL_SYNC_EMPTY_DAYS_THRESHOLD}`
            );

            // Stop if we've reached the threshold
            if (consecutiveEmptyDays >= FULL_SYNC_EMPTY_DAYS_THRESHOLD) {
              console.log(
                `🛑 Reached ${FULL_SYNC_EMPTY_DAYS_THRESHOLD} consecutive empty days, stopping full sync`
              );
              break;
            }
          } else {
            // Reset consecutive empty days counter when we get data
            consecutiveEmptyDays = 0;
            console.log(
              `📥 Fetched ${lifelogs.length} lifelogs for ${dateStr}`
            );
            await processLifelogs(lifelogs, dataDir, syncState);
            totalProcessed += lifelogs.length;
          }

          // Update sync state
          console.log("💾 Updating sync state...");
          syncState.lastSyncTime = new Date().toISOString();
          await saveSyncState(syncState);

          // Move to previous day
          currentDate.setDate(currentDate.getDate() - 1);

          // Polite delay between requests
          console.log("⏰ Waiting before next request...");
          await sleep(RATE_LIMIT_DELAY);
        } catch (error) {
          console.error("❌ Error during export:", error.message);
          if (error.response) {
            console.error(
              "❌ API Response:",
              JSON.stringify(error.response.data, null, 2)
            );
          }
          // Save failed attempt
          console.log("💾 Saving failed attempt to sync state...");
          syncState.failedAttempts.push({
            timestamp: new Date().toISOString(),
            date: dateStr,
            error: error.message,
            response: error.response?.data,
          });
          await saveSyncState(syncState);
          throw error;
        }
      }
    } else {
      // Regular sync mode - use cursor-based pagination
      console.log("🔄 Regular sync mode - using cursor-based pagination...");
      let cursor = null;

      while (true) {
        batchCount++;
        console.log(`\n🔄 Processing batch ${batchCount}...`);

        const params = {
          limit: BATCH_SIZE.toString(),
          includeMarkdown: "true",
          includeHeadings: "true",
          direction: "desc",
        };

        if (cursor) {
          params.cursor = cursor;
          console.log(`🔗 Using cursor: ${cursor.substring(0, 20)}...`);
        } else {
          console.log(
            `🕐 Starting from most recent data (no time constraints)`
          );
        }

        try {
          console.log("🌐 Fetching lifelogs from API...");
          const response = await fetchLifelogs(apiUrl, params);
          const lifelogs = response.data.lifelogs;

          if (!lifelogs || lifelogs.length === 0) {
            console.log("📭 Received empty lifelog response");
            if (cursor) {
              console.log("🔄 Continuing to next batch after empty response");
              cursor = response.data.meta?.lifelogs?.nextCursor;
              if (!cursor) {
                console.log("🏁 No more data to process - reached end");
                break;
              }
              continue;
            } else {
              console.log("🏁 No data available from the start");
              break;
            }
          }

          // Check if we've reached the end date
          if (endDate) {
            const oldestLifelogDate = new Date(
              lifelogs[lifelogs.length - 1].startTime
            )
              .toISOString()
              .split("T")[0];
            console.log(
              `📅 Oldest lifelog in batch: ${oldestLifelogDate}, end date: ${endDate}`
            );
            if (oldestLifelogDate <= endDate) {
              console.log(`🛑 Reached end date ${endDate}, stopping sync`);
              break;
            }
          }

          console.log(`📥 Fetched ${lifelogs.length} lifelogs`);
          await processLifelogs(lifelogs, dataDir, syncState);

          totalProcessed += lifelogs.length;

          // Extract cursor from response
          cursor =
            response.data.meta?.lifelogs?.nextCursor ||
            response.data.meta?.nextCursor ||
            response.data.nextCursor;

          console.log(
            `🔗 Extracted cursor: ${
              cursor ? cursor.substring(0, 20) + "..." : "null"
            }`
          );
          console.log(`📊 Total processed so far: ${totalProcessed}`);

          // Update sync state
          console.log("💾 Updating sync state...");
          syncState.lastSyncTime = new Date().toISOString();
          await saveSyncState(syncState);

          // Polite delay between requests
          console.log("⏰ Waiting before next request...");
          await sleep(RATE_LIMIT_DELAY);

          // Check if we should continue
          if (!cursor || lifelogs.length < BATCH_SIZE) {
            if (!cursor) {
              console.log("🏁 No more cursor, export completed successfully!");
            } else {
              console.log(
                `🏁 Got ${lifelogs.length} entries (less than batch size ${BATCH_SIZE}), export completed successfully!`
              );
            }
            break;
          }

          console.log("🔄 Continuing to next batch...");
        } catch (error) {
          console.error("❌ Error during export:", error.message);
          if (error.response) {
            console.error(
              "❌ API Response:",
              JSON.stringify(error.response.data, null, 2)
            );
          }
          // Save failed attempt
          console.log("💾 Saving failed attempt to sync state...");
          syncState.failedAttempts.push({
            timestamp: new Date().toISOString(),
            cursor,
            error: error.message,
            response: error.response?.data,
          });
          await saveSyncState(syncState);
          throw error;
        }
      }
    }

    console.log(
      `🎉 Export completed! Total lifelogs processed: ${totalProcessed}`
    );
  } catch (error) {
    console.error("💥 Fatal error exporting lifelogs:", error.message);
    if (error.response) {
      console.error(
        "💥 API Response:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    process.exit(1);
  }
}

console.log("🚀 Calling exportLifelogs function...");
exportLifelogs(isFullSync);
