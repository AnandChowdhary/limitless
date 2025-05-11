// https://github.com/limitless-ai-inc/limitless-api-examples/blob/50aa14a67be17f59b0fa443e524378cde4acbd3b/typescript/_client.ts

import axios from "axios";

const MAX_RETRIES = 3;
const TIMEOUT = 30000; // 30 seconds

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getLifelogs({
  apiKey,
  apiUrl = process.env.LIMITLESS_API_URL || "https://api.limitless.ai",
  endpoint = "v1/lifelogs",
  limit = 50,
  batchSize = 10,
  includeMarkdown = true,
  includeHeadings = false,
  date,
  timezone,
  direction = "asc",
}) {
  const allLifelogs = [];
  let cursor;

  // If limit is null, fetch all available lifelogs
  // Otherwise, set a batch size and fetch until we reach the limit
  if (limit !== null) {
    batchSize = Math.min(batchSize, limit);
  }

  while (true) {
    const params = {
      limit: batchSize.toString(),
      includeMarkdown: includeMarkdown.toString(),
      includeHeadings: includeHeadings.toString(),
      direction,
    };

    if (date) {
      params.date = date;
    }

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

        // Add transcripts from this batch
        allLifelogs.push(...lifelogs);

        // Check if we've reached the requested limit
        if (limit !== null && allLifelogs.length >= limit) {
          return allLifelogs.slice(0, limit);
        }

        // Get the next cursor from the response
        const nextCursor = response.data.meta.lifelogs.nextCursor;

        // If there's no next cursor or we got fewer results than requested, we're done
        if (!nextCursor || lifelogs.length < batchSize) {
          break;
        }

        console.log(
          `Fetched ${lifelogs.length} lifelogs, next cursor: ${nextCursor}`
        );
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
        console.log(`Request failed, retrying (${retries}/${MAX_RETRIES})...`);
        await sleep(1000 * retries); // Exponential backoff
      }
    }
  }

  return allLifelogs;
}
