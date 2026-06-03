# Aether AI Assistant

![Python](https://img.shields.io/badge/Python-3.11+-blue.svg) ![AI Assistant](https://img.shields.io/badge/AI-Assistant-red.svg) ![Local App](https://img.shields.io/badge/Local-App-blue.svg) ![Status](https://img.shields.io/badge/Status-Development-yellow.svg)

---

## Demo

- [Watch the demo video](./demo%20video.mp4)
- [Open the GitHub repository](https://github.com/professoralbay/aether-ai-assistant)
- [Run the app locally](#run-locally)

> Note: This project needs a local Node.js server. A `127.0.0.1` link only works after the user starts the app on their own computer.

---

## About the Project

**Aether AI Assistant** is a local AI-powered desktop assistant. It combines a browser-based chat interface with local server logic, AI model integration, command handling, and persistent chat history.

The project is designed to run on the user's own computer. Sensitive settings are kept locally in `.env`, and chat history is stored in local JSON files.

## Key Features

- AI assistant interface served through a local web app
- Voice input and text command support in the browser UI
- Chat history storage with clear-history support
- Hugging Face and Gemini backend configuration through environment variables
- Local-first workflow with no public hosting required

## How It Works

1. `BASLA.bat` starts the local server.
2. The browser opens the app at `http://127.0.0.1:8000`.
3. `index.html` provides the chat interface.
4. The server receives user commands and forwards them to the configured AI backend.
5. Responses and chat history are saved locally.

## Privacy

- The app runs locally on your computer.
- API keys stay in the local `.env` file.
- Chat history is saved locally in `chat_history.json`.
- Do not commit `.env` or private API keys to GitHub.

## Installation

1. Clone the repository:

```bash
git clone https://github.com/professoralbay/aether-ai-assistant.git
cd aether-ai-assistant
```

2. Install the required dependencies for the project.

3. Add your API keys to `.env` if needed.

## Run Locally

On Windows, start the project with:

```bat
BASLA.bat
```

Then open:

```text
http://127.0.0.1:8000
```

## Technology Stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js, Python
- **AI Backends:** Hugging Face, Gemini
- **Storage:** Local JSON files

## Contribution

Contributions are welcome. Feel free to open an issue or submit a pull request.

## License

This project is licensed under the MIT License.

Built by [professoralbay](https://github.com/professoralbay)