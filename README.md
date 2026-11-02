# Nova: AI Chatbot

A simple, fast and friendly AI chatbot that runs in your browser. Replies stream in word by word as they're written. It's powered by [Google Gemini](https://ai.google.dev/) through Google's official Gen AI SDK, with a small Node.js + Express backend and a plain HTML/CSS/JavaScript frontend. There's no build step.

## Features

- **Real-time messaging**: replies stream token by token over Server-Sent Events, and you can stop generation at any time.
- **Natural language understanding and accurate answers**: uses Gemini with full conversation context, so follow-up questions just work.
- **Automatic model fallback**: if the main Gemini model is overloaded, rate-limited or retired, Nova switches to a backup model.
- **🎨 Image generation**: switch on **Image mode** and describe a picture. Nova creates it, and you can open it full size or download it. Follow-up prompts like "make it blue" edit the last image. *Needs a Gemini plan that includes image models (see [Image generation and billing](#image-generation-and-billing)).*
- **📎 Images, PDFs and text files**: attach up to 5 files per message with the paperclip button, by drag-and-drop, or by pasting. Ask questions about photos, screenshots, documents and code. Large photos are shrunk automatically before upload.
- **🎤 Voice input**: click the microphone and speak; your words are typed into the message box (Chrome, Edge and Safari).
- **✏️ Edit and resend**: edit any earlier message of yours; Nova replaces everything after it with a fresh answer.
- **✨ Suggested follow-ups**: two or three clickable follow-up questions appear under each answer.
- **🔍 Search and ⬇️ export**: search all your chats (titles, messages and file names) from the sidebar, and export the current chat as a Markdown file.
- **Chat history**: conversations are saved in your browser (text in localStorage, files and images in IndexedDB) and listed in a sidebar. You can reopen or delete them.
- **Typing indicator**: animated dots while Nova thinks, then a live cursor while the reply streams in.
- **Clear chat**: clears the current conversation after a confirmation dialog.
- **Error handling**: plain-language messages for a missing or invalid API key, quota and rate limits, high demand, network or offline problems, and an unreachable server. Each comes with a **Retry** button.
- **Welcome screen and suggested questions**: a greeting plus one-click starter prompts.
- **Rich formatting**: Markdown replies with headings, lists, tables, links and code blocks (each with a **Copy** button). All output is HTML-escaped, so a reply can't inject markup.
- **Clean, responsive UI**: works on desktop and mobile, with light and dark themes (it follows your system theme, and you can toggle it), keyboard support and screen-reader labels.
- **Extras**: copy and regenerate replies, an auto-growing input, a character counter and per-IP rate limiting.

## Tech stack

| Layer    | Technology |
|----------|------------|
| Frontend | HTML, CSS, vanilla JavaScript (ES modules) |
| Backend  | Node.js 20.12+, Express 5 |
| AI       | Google Gemini via [`@google/genai`](https://www.npmjs.com/package/@google/genai) |
| Tests    | Node's built-in test runner (`node --test`) |

## Getting started

### 1. Prerequisites

- [Node.js](https://nodejs.org/) **20.12 or newer** (check with `node --version`)
- A Gemini API key. Create one for free at [Google AI Studio](https://aistudio.google.com/apikey). It starts with `AIza`.

### 2. Install

```bash
git clone https://github.com/<your-username>/nova-chatbot.git
cd nova-chatbot
npm install
```

### 3. Configure your API key

Copy the example environment file and add your key:

```bash
# macOS / Linux / Git Bash
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Then open `.env` and set:

```env
GEMINI_API_KEY=AIza...
```

> `.env` is listed in `.gitignore`, so your key is never committed. Never put your API key in frontend code or in `.env.example`.

### 4. Run

```bash
npm start
```

Open **http://localhost:3000** in your browser and start chatting.

For development, `npm run dev` restarts the server automatically when you change a file. Changes to `.env` always need a restart.

## Configuration

All settings live in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | (required) | Your Gemini API key from Google AI Studio |
| `PORT` | `3000` | Port for the web server |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Main Gemini model |
| `GEMINI_FALLBACK_MODELS` | `gemini-flash-latest,gemini-flash-lite-latest` | Comma-separated backup models, tried in order when the main model is overloaded (503), rate-limited (429), timed out, or unavailable (404). Set it to an empty value to turn fallbacks off |
| `GEMINI_IMAGE_MODEL` | `gemini-3.1-flash-image` | Model used in Image mode |
| `GEMINI_IMAGE_FALLBACK_MODELS` | `gemini-3.1-flash-lite-image` | Backup image models, tried in order |
| `FOLLOW_UP_SUGGESTIONS` | `true` | Show suggested follow-up questions (costs one small extra request per answer). Set to `false` to turn off |
| `GEMINI_SUGGESTIONS_MODEL` | `gemini-flash-lite-latest` | Fast, cheap model that writes the follow-up suggestions |
| `MAX_TOKENS` | `8192` | Maximum length of one reply |
| `RATE_LIMIT_PER_MINUTE` | `30` | Requests to the AI endpoints allowed per IP address per minute (each answer uses two: the reply and its follow-ups) |
| `GEMINI_BASE_URL` | (Google's API) | Optional: send Gemini requests through a proxy or gateway |

### Image generation and billing

Image mode uses Gemini's image models. On the **free tier these usually have no quota**, so Nova shows *"Image generation hit your Gemini quota…"*. To use Image mode, enable billing for your project in [Google AI Studio](https://aistudio.google.com/). Text chat, file uploads, voice, follow-ups and everything else work on the free tier.

Google retires older models over time. When that happens, set `GEMINI_MODEL` to a current one from the [Gemini models list](https://ai.google.dev/gemini-api/docs/models). The `-latest` aliases always point to Google's newest Flash and Flash-Lite models.

To change Nova's personality or instructions, edit `SYSTEM_PROMPT` in [`server.js`](server.js). To change the starter prompts, edit `SUGGESTIONS` in [`public/app.js`](public/app.js).

## Project structure

```
nova-chatbot/
├── server.js            # Express server: static files + streaming /api/chat endpoint
├── lib/
│   ├── chat.js          # Request validation (messages, attachments, mode)
│   └── gemini.js        # Gemini streaming, images, follow-ups, model fallback, friendly errors
├── public/
│   ├── index.html       # App layout
│   ├── styles.css       # Styles, light/dark theme, responsive layout
│   ├── app.js           # Chat UI: streaming, history, attachments, image mode, voice, edit, search, export
│   ├── files.js         # Stores attachments and generated images in IndexedDB
│   └── markdown.js      # Small, safe Markdown renderer for replies
├── test/                # Unit tests (npm test)
├── .env.example         # Configuration template
└── .github/workflows/   # CI: runs the tests on every push
```

## How it works

1. You type a message. The browser sends the conversation so far to `POST /api/chat`.
2. The server validates the request, keeps the most recent 40 messages, and opens a streaming request to Gemini with the system prompt. If the model is busy, it tries the fallback models.
3. As Gemini writes, the server forwards each piece of text to the browser as a Server-Sent Event, and the UI renders it live.
4. When the reply finishes, it's saved to your browser's chat history. If the connection drops or you click **Stop**, the server cancels the Gemini request, so no quota is used on a reply nobody reads.

### API

`POST /api/chat`

```json
{
  "mode": "chat",
  "messages": [
    {
      "role": "user",
      "content": "What's in this photo?",
      "attachments": [
        { "kind": "inline", "name": "photo.jpg", "mimeType": "image/jpeg", "data": "<base64>" },
        { "kind": "text", "name": "notes.txt", "text": "file contents…" }
      ]
    }
  ]
}
```

`mode` is `"chat"` (default) or `"image"`. Attachments are optional and only allowed on user messages. Inline files can be PNG, JPEG, WebP, HEIC/HEIF or PDF (up to 7 MB each, 5 per message).

The response is an event stream:

```
data: {"type":"delta","text":"Hi"}
data: {"type":"delta","text":" there!"}
data: {"type":"image","mimeType":"image/png","data":"<base64>"}     (image mode)
data: {"type":"done","stopReason":"end_turn","model":"gemini-3.6-flash"}
```

`POST /api/suggestions` takes `{ "messages": [...] }` (text only) and returns `{ "suggestions": ["…", "…", "…"] }`. It never fails loudly; on any error it returns an empty list.

`stopReason` is `end_turn` for a normal reply, `max_tokens` if the reply was cut off by the length limit, or `refusal` if Gemini's safety filters blocked it.

If something fails before any text is sent, the server returns a JSON error with a matching HTTP status. For example:

```json
{ "error": { "code": "rate_limited", "message": "The Gemini rate limit or free-tier quota was reached…", "retryable": true } }
```

`GET /api/health` returns the server status, the configured model, and whether an API key was found.

## Testing

```bash
npm test
```

The tests cover request and attachment validation, Gemini request building, image mode, follow-up parsing, error mapping, model fallback and the Markdown renderer (including HTML-injection safety). They don't call the real Gemini API.

## Deploying

The app is a standard Node.js server, so it runs on any Node host (Render, Railway, Fly.io, a VPS, and so on):

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment variables:** set `GEMINI_API_KEY` (plus any options above) in your host's dashboard. Don't upload `.env`.

The built-in rate limiter keeps its counts in memory, so they reset on restart and aren't shared between instances. If you run several instances behind a load balancer, put a shared rate limiter in front of them.

## Publishing to GitHub

```bash
git init
git add .
git commit -m "Initial commit: Nova AI chatbot"
git branch -M main
git remote add origin https://github.com/<your-username>/nova-chatbot.git
git push -u origin main
```

Before pushing, check that `git status` doesn't list `.env`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Banner says *"No Gemini API key was found"* | Create `.env` from `.env.example`, set `GEMINI_API_KEY`, and restart `npm start` |
| *"The server's Gemini API key is invalid"* | Check the key in Google AI Studio. It should start with `AIza`. Then restart the server |
| *"Gemini is experiencing high demand"* | Google's servers are busy. Wait a moment and click **Retry**, or add more models to `GEMINI_FALLBACK_MODELS` |
| *"rate limit or free-tier quota was reached"* | The free tier has per-minute and per-day limits. Wait, or enable billing in Google AI Studio |
| *"The configured Gemini model wasn't found"* | The model was retired or the name is wrong. Set `GEMINI_MODEL` to a current model |
| *"Image generation hit your Gemini quota"* | Image models usually aren't in the free tier. Enable billing in Google AI Studio |
| No microphone button | Your browser doesn't support speech recognition (e.g. Firefox). Use Chrome, Edge or Safari |
| *"Microphone access is blocked"* | Allow microphone access for the site in your browser's settings. Voice input needs `localhost` or HTTPS |
| A file won't attach | Supported: images (PNG, JPEG, WebP, HEIC), PDFs and text/code files, up to 7 MB each and 5 per message |
| *"Can't reach the chat server"* | Make sure `npm start` is running and you opened the right port |
| `process.loadEnvFile is not a function` | Upgrade Node.js to 20.12 or newer |

## License

[MIT](LICENSE)
