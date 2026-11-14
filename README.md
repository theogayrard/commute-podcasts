# Commute

A local podcast studio for your daily commute. Start with a topic, optionally add sources, choose your hosts, and turn the script into a downloadable episode or series.

## Run it

Requires **Node.js 24+** and Codex, signed in with your ChatGPT account. On Windows, Commute automatically finds the CLI bundled with the Codex desktop app, even when `codex` is not on PowerShell's PATH. It also checks standalone native CLI installations and the optional `CODEX_BIN` override.

```powershell
npm install
npm run codex:status
npm run dev
```

If the status says `Logged in using ChatGPT`, no additional login is needed. Otherwise, run `npm run codex:login` from this project folder and complete the browser sign-in. These project commands work even when typing `codex login` directly produces “The term 'codex' is not recognized.”

Open **http://localhost:4310**. In **Settings**, add the Gemini API key from your Google AI Studio project. You can also put `GEMINI_API_KEY` in a local `.env` file; see `.env.example`. No OpenAI API key is required for the ChatGPT subscription connection.

For a production build:

```powershell
npm run build
npm start
```

The server listens on loopback only. Keep it running while writing or recording. Use the download button to save the finished MP3 to your phone for offline listening. For private access from your phone away from home, follow the Tailscale setup below.

Optional local programs:

- **FFmpeg** creates normalized 128 kbps MP3s. Without it, recordings download as 24 kHz mono WAV.
- **yt-dlp** extracts public YouTube captions. Keep it updated as YouTube changes.

Both are already installed on the development computer. Paths can be configured with `CODEX_BIN`, `FFMPEG_BIN`, and `YTDLP_BIN`. `PORT` defaults to `4310`.

MP3 downloads include the episode title, **Commute** as the artist/author, **Podcast** as the genre, and embedded Commute cover art. This applies to existing recordings too: the first download prepares a tagged copy using FFmpeg without re-encoding the audio or generating speech, then reuses that copy for later downloads. WAV downloads keep their original format.

## Use it on your phone, anywhere

Your PC runs the app, writes scripts using its ChatGPT connection, and generates audio. Your phone connects through [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), which provides a private HTTPS address accessible while Tailscale is connected. Your PC must stay awake, connected to the internet, and running Commute.

1. Install [Tailscale](https://tailscale.com/download) on the PC and phone. Sign in on both using the same account and connect both devices.
2. In this project folder, run `npm run remote:setup`. If it prints a link to enable Serve/HTTPS, open that link and complete the one-time setup. The command detects this PC's private address and restricts app access to its Tailscale account.
3. Stop any running `npm run dev` with Ctrl+C. Run `npm run build`, then `npm start`. Leave the terminal running. Remote access is enabled only in this production mode.
4. On your phone, connect Tailscale and open the HTTPS address printed by the setup command. It works over cellular or another Wi-Fi network. On iPhone, use Safari's Share menu → Add to Home Screen for a shortcut.
5. To check the connection away from your home network, turn off Wi-Fi on the phone while leaving Tailscale on, then open the library and play an episode. Download the MP3 for offline listening.

After restarting the PC, reconnect Tailscale and run `npm start` in this folder. The Serve configuration persists; setup does not need repeating unless the account, device address, or app port changes. The app does not automatically start with Windows or prevent sleep. Locking Windows is fine; sleeping, shutting down, or closing the app stops access and generation.

To turn off phone access on Windows:

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' serve --https=443 off
```

Run `npm run remote:setup` and restart `npm start` to enable it again. No router port forwarding is needed. Use **Serve**, which is private; do not enable the public Funnel feature. Configuration is stored locally in `.data/remote-access.json`. The backend still listens only on `127.0.0.1`; it checks the exact private hostname, Tailscale-supplied account identity, and browser origin. Other Tailscale users and requests without that identity are denied, including audio downloads. Do not put another reverse proxy in front of the local bypass or enable Express `trust proxy`.

## The workflow

1. Enter a topic. Add up to 12 article/PDF links, YouTube videos, or files if helpful.
2. Choose one or two hosts from six recurring personas. Maya/Kore and Leo/Puck are the original listening-test pair. Host previews use Gemini once and are cached locally.
3. Choose 5–60 minutes, with an adjustable tolerance. The default is **30 minutes ±3**. Choose a single episode or a series of 2–12 episodes.
4. Select a model from your signed-in account and choose English or French.
5. Create the podcast. The app plans the series and writes complete chapters in sequence, saving progress after each one.
6. Review or edit the transcript, then generate audio. A series can be recorded together with **Record the whole series**. Playback includes seeking, 15-second skips, playback speed, and downloads.
7. Use **Delete** on a library card or **Delete episode** on its detail page to permanently remove an episode, its script, and saved audio after confirmation. Other episodes in the series keep their original numbering. Finish or stop generation for that podcast before deleting.

The original 4:32 Gemini listening test has been imported into the local library on the development computer. It is personal data in `.data`, not a bundled/fake example in source control.

## Follow-up episodes

Open any episode with a finished script and choose **Create a follow-up**. Describe what you want to explore next and optionally add new links or files. The form starts with the original episode’s hosts, duration, language, and sound preferences; you can change them before creating the next episode. Follow-ups are created one at a time and can have follow-ups of their own. Each episode page links to its predecessor and any direct follow-ups.

Planning and chapter writing receive the earlier conversations in that chain, with instructions to bridge briefly, skip material already covered, and develop new depth. Long transcripts are excerpted with chapter headings and excerpts from both ends retained. Earlier dialogue is continuity context, not a substitute for factual sources; **Use only these sources** still restricts new factual claims to the sources added to the follow-up. Review the generated script for repetition and accuracy before recording.

Conversation context is saved locally when the follow-up draft is created and reused on retries. Editing or deleting an earlier episode does not change existing follow-ups or their saved context. Deleting a follow-up removes its own context record; any descendants keep their independent snapshots. An episode without a complete script must finish writing before a follow-up can be created.

## Music and ambience

New podcasts have **Automatically choose music & ambience** enabled in the creation form. After writing, the app reads the complete script and chooses a consistent instrumental theme plus occasional chapter transitions or ambience. Uncheck the option for voice-only episodes. The sound-selection pass uses your existing writing connection; it does not use Gemini or a separate music service.

Open an episode’s **Music & ambience** tab to preview clips, change the theme, replace or remove cues, choose a chapter, and adjust duration or level. **Choose sounds automatically** also works on existing completed scripts. **Add opening & closing** lets you start manually without a writing connection. Save the soundtrack before recording, or use **Apply to recording** to remix a completed episode. **Hear in episode** plays from a cue’s actual position after mixing. Turning off **Include music & ambience** and applying the change restores a voice-only mix.

The bundled library contains **10 CC0 clips**: three instrumental themes, three matching transitions, and four field recordings (forest, rain, ocean and fireplace). They are excerpts from recordings by The Cynic Project, Cleyton Kauffman, Centurion_of_war, deadrobotmusic, rasunter255, SamsterBirdies and RyanKingArt. Creator links appear in the app. See [credits](assets/sounds/CREDITS.md) and [exact sources, edits and checksums](assets/sounds/SOURCES.json). Playback and mixing use local files; no sound downloads, extra accounts, or music-generation fees are required. Developers can rebuild the bundled excerpts with `npm run sounds:prepare` (requires internet access and FFmpeg).

Sound design is deliberately sparse: at most six cues, with opening/closing music and up to four interior moments. Interior cues start at measured chapter boundaries, not estimated sentence timestamps. The planner avoids literal sound effects for metaphors or passing mentions and may leave the middle quiet. Music fades smoothly and drops further under speech. An opening adds 1.2 seconds before narration, a transition adds a 0.65-second pause, and closing music adds a 2-second tail. Speech is never cut, stretched, or sent to TTS again for a soundtrack change.

The original narration and chapter timings are retained separately. Older recordings made by Commute recover timings from their cached sections; imported recordings without those sections support opening and closing cues only, with a notice if chapter cues are skipped. Missing originals produce an error instead of silently generating paid speech. Script edits clear the old sound plan and invalidate its timings. Failed or stopped remixes preserve the previously completed recording. If automatic selection is unavailable, the app explicitly falls back to opening and closing music, and offers a retry.

## Generation and sources

**Writing:** the local Codex CLI reuses your ChatGPT login. The model picker uses the official app-server `model/list` endpoint, rather than a hardcoded model list. The app refuses API-key-only Codex authentication to avoid silently switching subscription work to API billing. Codex model availability can differ from ChatGPT chat mode. You can paste an existing script into a draft if you prefer writing in ChatGPT itself.

Script jobs run in an isolated temporary directory, with the shell, plugins, apps, and additional agents disabled and a read-only sandbox. No Gemini or provider API keys are inherited by the writer. Topic-led generation can use web search; the “Use only these sources” setting disables it. Each episode has a shared series outline and receives its own previous chapters to reduce repetition. The planning schema specifies the requested episode and chapter counts; an invalid plan gets up to two automatic correction attempts before the job asks for a manual retry. Only a complete, validated plan is saved. Generation uses your subscription limits.

**Audio:** the adapter uses `gemini-3.8-flash-tts` through the Gemini Interactions API. Speaker names and delivery styles use structured speech metadata, separate from the spoken text. Long scripts split at chapter/turn boundaries into roughly 6,500-character sections. Each successful section is cached by its exact text, voices, model, and styles. Retry resumes from those cached sections. Changed scripts invalidate only the affected sections.

WAV files are parsed by their RIFF chunks rather than assuming a fixed 44-byte header. The app checks sample format and plausibility of section duration, joins PCM audio, measures actual duration, mixes any selected soundtrack, and optionally normalizes/encodes MP3 with FFmpeg. It does **not** stretch audio, add padding, or cut the ending to meet the time target. Optional musical bookends and chapter transitions add only their short intentional pauses. Out-of-range scripts and recordings display a notice.

Supported files: **PDF, DOCX, TXT, Markdown, CSV, SRT, VTT**, up to 15 MB each. PDFs must contain selectable text. Web articles are extracted with Mozilla Readability. YouTube ingestion requires accessible English or French captions; restricted or uncaptioned videos need a supplied transcript. Uploaded originals are not retained; extracted text is saved locally. Sources are capped at 60,000 characters each and 180,000 characters per writing prompt, with truncation disclosed.

## Storage and recovery

- `.data/commute.sqlite`: podcasts, sources, scripts, episode state, and job history.
- `.data/audio/<episode-id>/`: generated sections and finished recordings.
- `.data/audio/<episode-id>/download-*.mp3`: cached downloads with episode metadata and embedded cover art. A changed title, recording, or cover produces a fresh copy.
- `.data/audio/<episode-id>/narration.wav` and `narration.json`: original speech, content fingerprint, checksum and measured chapter starts for local remixes. Completed mixes have versioned filenames so playback can finish reading the version it started.
- `assets/sounds/`: the bundled CC0 sound library, provenance and credits.
- `.data/voices/`: cached host previews.
- `.data/settings.json`: locally saved Gemini key, if entered through Settings. It is a local plaintext configuration file, not an encrypted credential vault. Environment configuration is also supported.

`.data`, `.env`, dependencies, and build artifacts are excluded from Git. The browser receives only the Gemini connection status, never the saved key. The app accepts local access and, when configured in production, authenticated Tailscale access. It rejects cross-origin write requests, validates source destinations at URL and DNS-connection time, and blocks private/reserved network addresses and redirects to them. Only explicit audio download routes can serve files from `.data`.

After a server restart, unfinished jobs are marked interrupted and require an explicit retry. They do not restart paid generation automatically. Stopping a series cancels both its current recording and queued episodes. Already completed sections remain available for retry.

## Development and verification

React + TypeScript + Vite frontend, Express + Node SQLite backend. The server serves Vite middleware during development; restart `npm run dev` after changing server files. Frontend changes reload automatically.

```powershell
npm run check
npm test
npm run build
```

The automated tests cover input validation, file/PDF extraction, public-source restrictions, YouTube URL parsing, structured voice requests, WAV parsing, cached audio retries, transcript editing, interrupted jobs, multi-episode writing recovery, HTTP upload/download behavior, and Tailscale identity/hostname/origin checks. Providers are replaced with deterministic fixtures in automated tests, so tests do not incur generation charges.

Soundtrack tests also check every bundled asset and its checksum, script-based direction and fallback, consistent series themes, actual cue timing, voice preservation, clipping protection, cancellation, old recording recovery, editing/preview routes, and remixes with no TTS calls. The FFmpeg integration test encodes a real mix when FFmpeg is installed.

An opt-in full-length sound check uses one writing request and an existing completed episode; it never generates speech and writes only to `.qa/soundtrack-data`:

```powershell
npx tsx scripts/smoke-soundtrack.ts
```

A separate opt-in live writer smoke check uses a small amount of your ChatGPT subscription quota:

```powershell
npx tsx scripts/smoke-writer.ts
```

The live ChatGPT connection and complete article-to-script pipeline were verified: a five-minute target produced a 663-word, two-host script (estimated 4.6 minutes). The existing Gemini recording was checked in the player, and MP3 assembly was smoke-tested with local test audio. **A new full-length, end-to-end recording still needs a Gemini key and a listening test.** Automated duration checks do not verify every spoken word, voice consistency, or factual accuracy. The app does not yet include scheduled generation, RSS feeds, cloud hosting, or multi-user accounts.

## Provider references

- [OpenAI: ChatGPT authentication for Codex](https://learn.chatgpt.com/docs/auth)
- [OpenAI: non-interactive execution and structured output](https://learn.chatgpt.com/docs/non-interactive-mode)
- [OpenAI: app-server model discovery](https://learn.chatgpt.com/docs/app-server)
- [Google: Gemini 3.8 speech generation and request format](https://ai.google.dev/gemini-api/docs/speech-generation)

Model IDs and the Gemini request schema were checked against these official references on November 5, 2026.
