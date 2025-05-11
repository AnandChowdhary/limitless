#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { getLifelogs } from "./_client.js";

// Ensure the API key is provided
const apiKey = process.env.LIMITLESS_API_KEY;
if (!apiKey) {
  console.error("Error: LIMITLESS_API_KEY environment variable is required");
  process.exit(1);
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

    // Sort by created_at to maintain chronological order
    mergedData.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

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

async function exportLifelogs() {
  try {
    // Create data directory if it doesn't exist
    const dataDir = path.join(process.cwd(), "data");
    await ensureDirectoryExists(dataDir);

    // Fetch all lifelogs
    console.log("Fetching lifelogs...");
    const lifelogs = await getLifelogs({
      apiKey,
      includeMarkdown: true,
      includeHeadings: true,
    });

    // Group and save lifelogs by date as we receive them
    const lifelogsByDate = {};
    for (const lifelog of lifelogs) {
      const date = new Date(lifelog.created_at).toISOString().split("T")[0];
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

    console.log("Export completed successfully!");
  } catch (error) {
    console.error("Error exporting lifelogs:", error.message);
    process.exit(1);
  }
}

exportLifelogs();
