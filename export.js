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

    // Group lifelogs by date
    const lifelogsByDate = {};
    for (const lifelog of lifelogs) {
      const date = new Date(lifelog.created_at).toISOString().split("T")[0];
      if (!lifelogsByDate[date]) {
        lifelogsByDate[date] = [];
      }
      lifelogsByDate[date].push(lifelog);
    }

    // Save each day's lifelogs to a separate file
    for (const [date, logs] of Object.entries(lifelogsByDate)) {
      const filePath = path.join(dataDir, `${date}.json`);
      await ensureDirectoryExists(path.dirname(filePath));
      await fs.writeFile(filePath, JSON.stringify(logs, null, 2));
      console.log(`Saved ${logs.length} lifelogs to ${filePath}`);
    }

    console.log("Export completed successfully!");
  } catch (error) {
    console.error("Error exporting lifelogs:", error.message);
    process.exit(1);
  }
}

exportLifelogs();
