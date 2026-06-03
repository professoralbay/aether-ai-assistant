# AI Security System

![Python](https://img.shields.io/badge/Python-3.11+-blue.svg) ![AI Security](https://img.shields.io/badge/AI-Security-red.svg) ![Biometric](https://img.shields.io/badge/Biometric-Authentication-orange.svg) ![Status](https://img.shields.io/badge/Status-Development-yellow.svg)

---

## Demo

[Try the Local Demo](http://127.0.0.1:8000)

> To test the project, run `BASLA.bat` first, then open the demo link.

<video src="./demo_video.mp4" controls width="700"></video>

[Watch or download the demo video](./demo_video.mp4)

---

## About the Project

**AI Security System** is a local AI-powered desktop assistant and security project. It combines a browser-based chat interface with local server logic, AI model integration, command handling, and persistent chat history.

The project is designed to run on the user's own computer. Sensitive settings are kept locally in `.env`, and chat history is stored in local JSON files.

## Key Features

- AI assistant interface served through a local web app
- Local demo link for testing on `http://127.0.0.1:8000`
- Voice input and text command support in the browser UI
- Chat history storage with clear-history support
- Hugging Face and Gemini backend configuration through environment variables
- Local-first workflow with no public hosting required

## How It Works

1. `BASLA.bat` starts the Node.js server.
2. The browser opens the local app at `http://127.0.0.1:8000`.
3. `index.html` provides the chat interface.
4. `server.js` receives user commands and forwards them to the configured AI backend.
5. Responses and chat history are saved locally.

## Privacy

- The app runs locally on your computer.
- API keys stay in the local `.env` file.
- Chat history is saved locally in `chat_history.json`.
- Do not commit `.env` or private API keys to GitHub.

## Installation

1. Clone the repository:

```bash
git clone https://github.com/professoralbay/ai-guvenlik.git
cd ai-guvenlik
```

2. Install the required dependencies for the project.

3. Add your API keys to `.env` if needed.

## Run

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
