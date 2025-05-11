#!/usr/bin/env node

import axios from "axios";
import fs from "fs/promises";
import path from "path";

const MAX_RETRIES = 3;
const TIMEOUT = 30000; // 30 seconds

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

async function appendToFile(filePath, newLifelogs) {
  try {
    // Read existing data if file exists
    let existingData = [];
    try {
      const content = await fs.readFile(filePath, "utf-8");
      existingData = JSON.parse(content);
    } catch (error) {
      // File doesn't exist or is invalid JSON, start fresh
    }

    // Merge new data with existing data
    const mergedData = [...existingData, ...newLifelogs];

    // Sort by startTime to maintain chronological order
    mergedData.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    // Remove duplicates based on id
    const uniqueData = Array.from(
      new Map(mergedData.map((item) => [item.id, item])).values()
    );

    // Write back to file
    await fs.writeFile(filePath, JSON.stringify(uniqueData, null, 2));
    console.log(`Updated ${filePath} with ${newLifelogs.length} new lifelogs`);
  } catch (error) {
    console.error(`Error updating ${filePath}:`, error.message);
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

  // Save each day's lifelogs immediately
  for (const [date, logs] of Object.entries(lifelogsByDate)) {
    const filePath = path.join(dataDir, `${date}.json`);
    await ensureDirectoryExists(path.dirname(filePath));
    await appendToFile(filePath, logs);
  }
}

async function exportLifelogs() {
  try {
    // Create data directory if it doesn't exist
    const dataDir = path.join(process.cwd(), "data");
    await ensureDirectoryExists(dataDir);

    const apiUrl = process.env.LIMITLESS_API_URL || "https://api.limitless.ai";
    const endpoint = "v1/lifelogs";
    const batchSize = 10;
    let cursor;

    while (true) {
      const params = {
        limit: batchSize.toString(),
        includeMarkdown: "true",
        includeHeadings: "true",
        direction: "asc",
      };

      if (cursor) {
        params.cursor = cursor;
      }

      let retries = 0;
      while (retries < MAX_RETRIES) {
        try {
          const response = await axios.get(`${apiUrl}/${endpoint}`, {
            headers: { "X-API-Key": apiKey },
            params,
            timeout: TIMEOUT,
          });

          const lifelogs = response.data.data.lifelogs;
          console.log(`Fetched ${lifelogs.length} lifelogs`);

          // Process and save this batch immediately
          await processLifelogs(lifelogs, dataDir);

          // Get the next cursor from the response
          const nextCursor = response.data.meta.lifelogs.nextCursor;

          // If there's no next cursor or we got fewer results than requested, we're done
          if (!nextCursor || lifelogs.length < batchSize) {
            console.log("Export completed successfully!");
            return;
          }

          console.log(`Next cursor: ${nextCursor}`);
          cursor = nextCursor;
          break; // Success, exit retry loop
        } catch (error) {
          retries++;
          if (retries === MAX_RETRIES) {
            if (axios.isAxiosError(error)) {
              throw new Error(
                `HTTP error! Status: ${error.response?.status} after ${MAX_RETRIES} retries`
              );
            }
            throw error;
          }
          console.log(
            `Request failed, retrying (${retries}/${MAX_RETRIES})...`
          );
          await sleep(1000 * retries); // Exponential backoff
        }
      }
    }
  } catch (error) {
    console.error("Error exporting lifelogs:", error.message);
    process.exit(1);
  }
}

exportLifelogs();
