# ✨ Limitless to git

Export your [Limitless](https://limitless.ai) lifelogs to JSON files organized by date using GitHub Actions. This tool helps you maintain a local backup of your lifelogs and makes it easy to version control your data using git.

## Installation

1. Create a new repository using this template:

   - Click the "Use this template" button at the top of this repository
   - Name your new repository
   - Add your Limitless API key as a secret:
     - Go to your new repository's Settings > Secrets and variables > Actions
     - Create a new repository secret named `LIMITLESS_API_KEY`
     - Add your Limitless API key as the value

2. Clone your new repository:

```bash
git clone https://github.com/yourusername/limitless.git
cd limitless
```

3. Install dependencies:

```bash
npm install
```

## Usage

### Automated Export (Recommended)

The repository includes a GitHub Action that automatically exports your lifelogs every day at midnight UTC. No additional setup is required - just make sure you've added your `LIMITLESS_API_KEY` secret as described in the installation steps.

### Manual Export

You can also run the export script locally:

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

- **Automated daily exports**: GitHub Actions automatically exports your lifelogs every day at midnight UTC
- **Incremental updates**: The script can be run multiple times safely. It will update existing files rather than overwriting them.
- **Deduplication**: Automatically removes duplicate entries based on lifelog ID.
- **Chronological order**: Maintains chronological order of entries within each file.
- **Error handling**: Gracefully handles network issues and timeouts with automatic retries.
- **Progress tracking**: Shows detailed progress as it exports the data.

## License

[MIT](./LICENSE) (c) [Anand Chowdhary](https://anandchowdhary.com)
