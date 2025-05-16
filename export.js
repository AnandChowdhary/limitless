#!/usr/bin/env node

import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";

const MAX_RETRIES = 3;
const TIMEOUT = 30000; // 30 seconds
const RATE_LIMIT_DELAY = 12000; // 12 seconds between requests to stay under 5 requests/minute
const BATCH_SIZE = 10;

// Zod schemas for API response validation
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
  meta: z.object({ lifelogs: z.object({ nextCursor: z.string().nullable() }) }),
});

// Ensure the API key is provided
const apiKey = process.env.LIMITLESS_API_KEY;
if (!apiKey) {
  console.error("Error: LIMITLESS_API_KEY environment variable is required");
  process.exit(1);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDirectoryExists(dirPath) {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

async function saveSyncState(state) {
  const statePath = path.join(process.cwd(), "data", ".sync-state.json");
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

async function loadSyncState() {
  try {
    const statePath = path.join(process.cwd(), "data", ".sync-state.json");
    const content = await fs.readFile(statePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { lastCursor: null, lastSyncTime: null, failedAttempts: [] };
  }
}

async function processLifelogs(lifelogs, dataDir) {
  // Group lifelogs by date
  const lifelogsByDate = {};
  for (const lifelog of lifelogs) {
    console.log("Processing lifelog:", {
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

  // Save each day's lifelogs as markdown
  for (const [date, logs] of Object.entries(lifelogsByDate)) {
    const markdownFilePath = path.join(dataDir, `${date}.md`);
    await ensureDirectoryExists(path.dirname(markdownFilePath));
    await createMarkdownFile(markdownFilePath, logs);
  }
}

async function createMarkdownFile(filePath, lifelogs) {
  try {
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
    console.log(`Created markdown file: ${filePath}`);
  } catch (error) {
    console.error(`Error creating markdown file ${filePath}:`, error.message);
    throw error; // Propagate error for better error handling
  }
}

async function fetchLifelogs(apiUrl, params, retryCount = 0) {
  try {
    const response = await axios.get(`${apiUrl}/v1/lifelogs`, {
      headers: { "X-API-Key": apiKey },
      params,
      timeout: TIMEOUT,
    });

    // Validate response structure with Zod
    try {
      const validatedData = LifelogsResponseSchema.parse(response.data);
      return validatedData;
    } catch (validationError) {
      console.error("API Response validation failed:", validationError);
      console.error(
        "Invalid response:",
        JSON.stringify(response.data, null, 2)
      );
      throw new Error("Invalid API response structure");
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 429) {
        // Rate limit hit, wait longer
        console.log("Rate limit hit, waiting 60 seconds...");
        await sleep(60000);
        return fetchLifelogs(apiUrl, params, retryCount);
      }

      if (retryCount < MAX_RETRIES) {
        console.log(
          `Request failed, retrying (${retryCount + 1}/${MAX_RETRIES})...`
        );
        await sleep(1000 * Math.pow(2, retryCount)); // Exponential backoff
        return fetchLifelogs(apiUrl, params, retryCount + 1);
      }
    }
    throw error;
  }
}

async function exportLifelogs() {
  try {
    // Create data directory if it doesn't exist
    const dataDir = path.join(process.cwd(), "data");
    await ensureDirectoryExists(dataDir);

    const apiUrl = process.env.LIMITLESS_API_URL || "https://api.limitless.ai";
    let syncState = await loadSyncState();
    let safeDateStr = null;

    // First, check if we're up to date with a descending request
    const checkParams = {
      limit: "1",
      includeMarkdown: "true",
      includeHeadings: "true",
      direction: "desc",
    };

    const latestData = await fetchLifelogs(apiUrl, checkParams);
    if (!latestData?.data?.lifelogs?.[0]) {
      console.log("No lifelogs found in the system");
      return;
    }

    const latestLifelog = latestData.data.lifelogs[0];
    const latestDate = new Date(latestLifelog.startTime)
      .toISOString()
      .split("T")[0];
    // Get the previous day as a safe point
    const safeDate = new Date(latestLifelog.startTime);
    safeDate.setDate(safeDate.getDate() - 1);
    safeDateStr = safeDate.toISOString().split("T")[0];
    console.log(
      `Latest lifelog is from ${latestDate}, using ${safeDateStr} as safe sync point`
    );

    // If we have a last sync time, check if we need to sync
    if (syncState.lastSyncTime) {
      const lastSyncDate = new Date(syncState.lastSyncTime)
        .toISOString()
        .split("T")[0];
      if (lastSyncDate >= safeDateStr) {
        console.log(
          `Already synced up to ${lastSyncDate}, which is after our safe point ${safeDateStr}`
        );
        return;
      }
    }

    // Now proceed with ascending sync
    let cursor = syncState.lastCursor;
    let totalProcessed = 0;

    while (true) {
      const params = {
        limit: BATCH_SIZE.toString(),
        includeMarkdown: "true",
        includeHeadings: "true",
        direction: "asc",
      };

      if (cursor) {
        params.cursor = cursor;
      }

      try {
        const response = await fetchLifelogs(apiUrl, params);
        const lifelogs = response.data.lifelogs;

        if (!lifelogs || lifelogs.length === 0) {
          console.log("No more lifelogs to process");
          break;
        }

        // Check if we've reached the safe date
        const lastLifelogDate = new Date(
          lifelogs[lifelogs.length - 1].startTime
        )
          .toISOString()
          .split("T")[0];
        if (lastLifelogDate >= safeDateStr) {
          console.log(`Reached safe sync point ${safeDateStr}, stopping sync`);
          break;
        }

        console.log(`Fetched ${lifelogs.length} lifelogs`);
        await processLifelogs(lifelogs, dataDir);

        totalProcessed += lifelogs.length;
        cursor = response.data.meta?.lifelogs?.nextCursor;

        // Update sync state
        syncState.lastCursor = cursor;
        syncState.lastSyncTime = new Date().toISOString();
        await saveSyncState(syncState);

        // Polite delay between requests
        await sleep(RATE_LIMIT_DELAY);

        if (!cursor || lifelogs.length < BATCH_SIZE) {
          console.log("Export completed successfully!");
          break;
        }
      } catch (error) {
        console.error("Error during export:", error.message);
        if (error.response) {
          console.error(
            "API Response:",
            JSON.stringify(error.response.data, null, 2)
          );
        }
        // Save failed attempt
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

    console.log(`Total lifelogs processed: ${totalProcessed}`);
  } catch (error) {
    console.error("Error exporting lifelogs:", error.message);
    if (error.response) {
      console.error(
        "API Response:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    process.exit(1);
  }
}

exportLifelogs();
