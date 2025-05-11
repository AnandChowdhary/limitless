# ✨ Limitless to git

Export your [Limitless](https://limitless.ai) lifelogs to JSON files organized by date. This tool helps you maintain a local backup of your lifelogs and makes it easy to version control your data using git.

## Installation

1. Clone this repository:

```bash
git clone https://github.com/yourusername/limitless.git
cd limitless
```

2. Install dependencies:

```bash
npm install
```

3. Set your Limitless API key:

```bash
export LIMITLESS_API_KEY="your-api-key-here"
```

## Usage

Run the export script:

```bash
npm start
```

The script will:

1. Create a `data` directory if it doesn't exist
2. Fetch your lifelogs from the Limitless API
3. Save them in JSON files organized by date (YYYY-MM-DD.json)
4. Show progress as it exports the data

## Output structure

```
data/
  2024-01-01.json
  2024-01-02.json
  2024-01-03.json
  ...
```

Each JSON file contains an array of lifelogs for that specific day, with all the details including markdown content and headings.

## Features

- **Incremental updates**: The script can be run multiple times safely. It will update existing files rather than overwriting them.
- **Deduplication**: Automatically removes duplicate entries based on lifelog ID.
- **Chronological order**: Maintains chronological order of entries within each file.
- **Error handling**: Gracefully handles network issues and timeouts with automatic retries.
- **Progress tracking**: Shows detailed progress as it exports the data.

## License

[MIT](./LICENSE) (c) [Anand Chowdhary](https://anandchowdhary.com)
