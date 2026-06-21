# ChalkAI Architecture

```mermaid
flowchart LR
  User["Student / User"] <--> App["ChalkAI Web App<br/>Whiteboard, Chat, Replay"]

  App <--> API["Local Backend API<br/>Coordinates tutoring, memory, voice, tracing"]

  API <--> Agent1["Agent 1: AI Tutor<br/>Explains, answers, draws, graphs"]
  Agent1 <--> Models["AI Models<br/>Anthropic / OpenAI"]

  API --> Agent2["Agent 2: Evaluator<br/>Reviews tutor quality"]
  Agent2 --> Memory["Redis Memory<br/>Session history + feedback"]
  API <--> Memory
  Memory --> Agent1

  API <--> Voice["Deepgram<br/>Speech + transcription"]
  API <--> Storage["Supabase<br/>Login + saved recordings"]

  API --> Arize["Arize<br/>Observability + traces"]

  Agent1 --> App
```

ChalkAI has two AI roles: Agent 1 tutors the student, while Agent 2 reviews how well Agent 1 taught. Agent 2's feedback is saved in Redis memory, so future tutoring responses can improve based on past sessions.

Most product paths are bidirectional because the app sends user/session data to the backend and receives streamed responses, recordings, transcripts, or saved state back. Arize is mostly one-way: the backend exports traces so the team can inspect what the AI is doing.
