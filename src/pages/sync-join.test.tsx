/* @vitest-environment jsdom
 * Sync flow integration tests: renders the REAL Practice component (creator)
 * in jsdom and drives a REAL StudyWsClient joiner against the REAL ws server.
 * Covers: base-screen session creation, combined-queue building, disconnect
 * grace, per-question answer persistence, queue re-filtering, heartbeats and
 * membership rejection. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import http from "node:http";
// @ts-expect-error server code is plain ESM JS without declarations
import { createWsServer } from "../../server/ws.mjs";
import { StudyWsClient } from "../lib/ws";
import { syncSessionStore } from "../lib/sync/sessionStore";
import type { QuizQuestion, PaukenUser, EnginePrefs, ClassEntity } from "../lib/types";

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer();
  /* Only class members may join a session (change #3). */
  createWsServer(server, {
    isMember: async (userId: string) => userId === "uA" || userId === "uB",
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  port = (server.address() as any).port;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  cleanup();
  /* Module-level store keeps its client/identity between tests, and the
   * persisted identity + last-used class survive in localStorage. */
  syncSessionStore.resetForTests();
  localStorage.clear();
});

function makeQuestions(n: number): QuizQuestion[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `q${i + 1}`,
    noteId: "n1",
    type: "mcq" as const,
    topic: "t1",
    difficulty: "basic" as const,
    question: `Question ${i + 1}?`,
    options: ["Alpha", "Beta", "Gamma", "Delta"],
    correctIndex: 0,
    explanation: "Because.",
    state: i < 3 ? ("review" as const) : ("new" as const),
    due: i < 3 ? Date.now() - 1000 : 4.1e12,
    stability: i < 3 ? 10 : 0,
    fsrsDifficulty: 5,
    reps: i < 3 ? 3 : 0,
    lapses: 0,
    lastReview: i < 3 ? Date.now() - 86400000 : undefined,
    generatedAt: Date.now() + i,
  }));
}

const questions = makeQuestions(12);
const cls: ClassEntity = {
  id: "c1",
  name: "Test Class",
  description: "",
  ownerId: "uA",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  retentionTarget: 0.9,
  maxReviewsPerItemPerWeek: 3,
  maxNewCardsPerSession: 10,
};

function makeRepo() {
  return {
    listClasses: vi.fn(async () => [cls]),
    questionsForClass: vi.fn(async () => questions),
    foldersForClass: vi.fn(async () => []),
    notesForClass: vi.fn(async () => []),
    listProgressForUser: vi.fn(async () => []),
    reviewLogsForUser: vi.fn(async () => []),
    membersForClass: vi.fn(async () => []),
    listUsers: vi.fn(async () => []),
    putProgress: vi.fn(async () => {}),
    putReviewLog: vi.fn(async () => {}),
    putAttempt: vi.fn(async () => {}),
    putActivityEvent: vi.fn(async () => {}),
  };
}

const user: PaukenUser = { id: "uA", name: "Alice", key: "key-a" };

function makePrefs(): EnginePrefs {
  return {
    mode: "cloud",
    onboarded: true,
    cloudProvider: "deepseek",
    cloudModel: "deepseek-chat",
    language: "en",
    defaultReminderTime: "09:00",
    generateSummary: true,
    avatar: "",
    showPartnerPick: true,
    serverUrl: `http://127.0.0.1:${port}`,
    userKey: "",
  };
}

/* Set by the test before importing Practice; the hoisted mock factory reads it
 * lazily when the mocked module is first imported. */
let mockRepo: ReturnType<typeof makeRepo> | null = null;
vi.mock("../lib/app", () => ({
  useApp: () => ({
    repo: mockRepo,
    user,
    prefs: makePrefs(),
    savePrefs: vi.fn(),
    bump: vi.fn(),
    version: 1,
  }),
}));

/* Simulate a data bug inside the combined-session builder so we can assert
 * the error surfaces in the session status instead of hanging the spinner. */
let buildCoStudyThrows = false;
vi.mock("../lib/study/session", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    buildCoStudySession: (...args: any[]) => {
      if (buildCoStudyThrows) throw new Error("boom");
      return mod.buildCoStudySession(...args);
    },
  };
});

/* Node's undici WebSocket global is broken under jsdom (cross-realm
 * EventTarget/Event mismatch). Force the ws package client instead —
 * StudyWsClient only uses onopen/onmessage/onclose/readyState/send. */
async function setupWsClient() {
  // @ts-expect-error ws ships its own types in wrapper.mjs
  const wsMod = await import("ws");
  (globalThis as any).WebSocket = wsMod.WebSocket;
}

async function renderPractice() {
  const { default: Practice } = await import("./Practice");
  render(
    <MemoryRouter initialEntries={["/practice"]}>
      <Practice />
    </MemoryRouter>,
  );
}

async function waitForSessionStarted() {
  try {
    await screen.findByText("Session started", {}, { timeout: 5000 });
  } catch {
    const body = document.body.textContent ?? "";
    throw new Error(
      "Creator stuck. Visible text: " +
        [...document.querySelectorAll("p, h2, span, button")]
          .map((e) => e.textContent?.trim())
          .filter(Boolean)
          .slice(0, 16)
          .join(" | ") +
        `\nFull body: ${body.slice(0, 600)}`,
    );
  }
}

/* Base-screen flow (change #3): no class picking in a header, no separate
 * create button — selecting a class in the synced card creates the session
 * and shows the code automatically. */
async function createSessionViaUi(): Promise<string> {
  await renderPractice();
  await screen.findByRole("button", { name: "Continue" });
  fireEvent.change(screen.getByLabelText("class for synced session"), {
    target: { value: "c1" },
  });
  await screen.findByText("Waiting for your partner…");
  const codeEl = await screen.findByText(/^\d{4}$/);
  const code = codeEl.textContent!;
  expect(code).toMatch(/^\d{4}$/);
  return code;
}

async function joinAs(code: string, uid: string, name: string) {
  const joiner = new StudyWsClient(`ws://127.0.0.1:${port}`);
  await joiner.connect();
  await joiner.joinSession(code, uid, name, [], []);
  joiner.onMessage(() => {});
  return joiner;
}

describe("sync join flow (real component)", () => {
  it("creator leaves 'building combined session' once the partner joins", async () => {
    await setupWsClient();
    mockRepo = makeRepo();

    const code = await createSessionViaUi();

    /* Joiner: real client joins with the code */
    const joiner = await joinAs(code, "uB", "Bob");

    /* The creator should leave the building state within a few seconds */
    await waitForSessionStarted();
    expect(screen.queryByText(/building combined session/i)).toBeNull();
    joiner.disconnect();
  });

  it("creator survives joiner's class-switch progress refresh (update_progress roundtrip)", async () => {
    await setupWsClient();
    mockRepo = makeRepo();

    const code = await createSessionViaUi();

    /* Joiner joins with progress referencing questions OUTSIDE the class
     * (simulating joining from a different class), then refreshes with real
     * progress after its class auto-switches — the creator must rebuild the
     * queue and re-send session_started without getting stuck. */
    const joiner = new StudyWsClient(`ws://127.0.0.1:${port}`);
    await joiner.connect();
    await joiner.joinSession(code, "uB", "Bob", [
      { id: "uB-other", userId: "uB", questionId: "other-class-q", state: "review", due: Date.now() - 1000, stability: 5, fsrsDifficulty: 5, reps: 3, lapses: 0 },
    ], []);
    await new Promise((r) => setTimeout(r, 150));
    joiner.updateProgress(
      [{ id: "uB-q1", userId: "uB", questionId: "q1", state: "review", due: Date.now() - 1000, stability: 8, fsrsDifficulty: 5, reps: 4, lapses: 0 }],
      [{ id: "l1", userId: "uB", questionId: "q1", rating: "good", stateBefore: { state: "review", due: Date.now() - 86400000, stability: 7, fsrsDifficulty: 5, reps: 3, lapses: 0 }, stateAfter: { state: "review", due: Date.now() + 86400000, stability: 8, fsrsDifficulty: 5, reps: 4, lapses: 0 }, at: Date.now() - 3600000 }],
    );

    await waitForSessionStarted();
    expect(screen.queryByText(/building combined session/i)).toBeNull();
    joiner.disconnect();
  });

  it("surfaces combined-session build errors in the session status", async () => {
    await setupWsClient();
    buildCoStudyThrows = true;
    try {
      mockRepo = makeRepo();
      const code = await createSessionViaUi();

      /* Joiner joins; the creator's handler throws inside buildCoStudySession
         (data bug) — the error must appear in the status, not vanish. */
      const joiner = await joinAs(code, "uB", "Bob");
      await screen.findByText(/Sync error: boom/, {}, { timeout: 5000 });
      joiner.disconnect();
    } finally {
      buildCoStudyThrows = false;
    }
  });

  it("rejects a join from a user who is not a class member", async () => {
    await setupWsClient();
    mockRepo = makeRepo();

    const code = await createSessionViaUi();

    /* uC is not in the class members list allowed by the server. */
    const joiner = new StudyWsClient(`ws://127.0.0.1:${port}`);
    await joiner.connect();
    await expect(
      joiner.joinSession(code, "uC", "Cara", [], []),
    ).rejects.toThrow("you are not a member of this class");
    joiner.disconnect();
  });

  it("replies to heartbeat pings (keep-alive)", async () => {
    await setupWsClient();
    const client = new StudyWsClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    const received: any[] = [];
    client.onMessage((m) => received.push(m));

    client.send({ type: "ping" });
    await vi.waitFor(() => {
      expect(received.some((m) => m.type === "pong")).toBe(true);
    });
    client.disconnect();
  });

  it("solo player reveals and continues after the partner leaves (no dead-end)", async () => {
    await setupWsClient();
    mockRepo = makeRepo();

    const code = await createSessionViaUi();
    const joiner = await joinAs(code, "uB", "Bob");
    await waitForSessionStarted();

    /* Partner leaves — the session must keep going for the remaining player. */
    joiner.leaveSession();
    await screen.findByText(/partner disconnected/i);

    /* Single click only stores the pick (live avatar) — no lock, no reveal. */
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(screen.queryByText("Because.")).toBeNull();

    /* Double-click on the same option LOCKs it in → solo reveal fires. */
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await screen.findByText("Because.", {}, { timeout: 5000 });

    /* Continue advances past the revealed question. */
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/Question 2\?/);
    joiner.disconnect();
  });

  it("keeps answers when navigating back to an answered question", async () => {
    await setupWsClient();
    mockRepo = makeRepo();

    const code = await createSessionViaUi();
    const joiner = await joinAs(code, "uB", "Bob");
    await waitForSessionStarted();

    /* Both lock an answer on question 1 → reveal. */
    joiner.lockAnswer(0, 0);
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await screen.findByText("Because.", {}, { timeout: 5000 });

    /* Continue to question 2, then navigate BACK to question 1. */
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/Question 2\?/);
    fireEvent.click(screen.getByTitle("Previous question"));

    /* The stored answer + reveal state must be restored, not cleared. */
    await screen.findByText("Because.", {}, { timeout: 5000 });
    expect(
      screen.getByText((_, el) => (el?.textContent ?? "").replace(/\s+/g, " ") === "Question 1 / 12"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    joiner.disconnect();
  });

  it("rejoins the session with full state after leaving the page (change #3)", async () => {
    await setupWsClient();
    mockRepo = makeRepo();
    const renderPracticeLocal = async () => {
      const { default: Practice } = await import("./Practice");
      render(
        <MemoryRouter initialEntries={["/practice"]}>
          <Practice />
        </MemoryRouter>,
      );
    };

    await renderPracticeLocal();
    await screen.findByRole("button", { name: "Continue" });
    fireEvent.change(screen.getByLabelText("class for synced session"), {
      target: { value: "c1" },
    });
    await screen.findByText("Waiting for your partner…");
    const code = (await screen.findByText(/^\d{4}$/)).textContent!;

    const joiner = await joinAs(code, "uB", "Bob");
    await waitForSessionStarted();

    /* Lock in an answer so the restore has a reveal state to show.
       Both participants must lock for the reveal to fire. */
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await new Promise((r) => setTimeout(r, 150));
    joiner.lockAnswer(0, 0);
    await screen.findByText("Because.", {}, { timeout: 5000 });

    /* Navigate away (unmount) and come back: the session auto-rejoins and
       restores position + reveal without recreating anything. */
    cleanup();
    await renderPracticeLocal();
    try {
      await screen.findByText("Because.", {}, { timeout: 5000 });
    } catch (e) {
      const body = document.body.textContent ?? "";
      throw new Error(
        "Rejoin restore failed. Visible: " +
          [...document.querySelectorAll("p, h2, span, button")]
            .map((el) => el.textContent?.trim())
            .filter(Boolean)
            .slice(0, 20)
            .join(" | ") +
          `\nFull body: ${body.slice(0, 800)}`,
      );
    }
    expect(
      screen.getByText((_, el) => (el?.textContent ?? "").replace(/\s+/g, " ") === "Question 1 / 12"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    joiner.disconnect();
  }, 20000);

  it("skip navigation and screen modes broadcast to the partner", async () => {
    await setupWsClient();
    mockRepo = makeRepo();

    const code = await createSessionViaUi();

    const joiner = new StudyWsClient(`ws://127.0.0.1:${port}`);
    await joiner.connect();
    await joiner.joinSession(code, "uB", "Bob", [], []);
    const received: any[] = [];
    joiner.onMessage((m) => received.push(m));
    await waitForSessionStarted();

    /* Creator skips forward → the shared position moves and the partner is
       told via a navigate session_state. */
    fireEvent.click(screen.getByTitle("Skip to next question"));
    await screen.findByText(/Question 2\?/);
    await vi.waitFor(() => {
      expect(
        received.some((m) => m.type === "session_state" && m.reason === "navigate" && m.session.currentIndex === 1),
      ).toBe(true);
    });

    /* Screen-mode change broadcasts to the partner. */
    const modeSelect = [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "independent"),
    );
    fireEvent.change(modeSelect!, { target: { value: "independent" } });
    await vi.waitFor(() => {
      expect(
        received.some((m) => m.type === "screen_mode_changed" && m.userId === "uA" && m.mode === "independent"),
      ).toBe(true);
    });
    joiner.disconnect();
  });

  it("rebuilds the shared queue from the creator's unit/topic filter", async () => {
    await setupWsClient();
    mockRepo = makeRepo();
    const mixed = makeQuestions(12).map((q, i) => ({ ...q, topic: i < 6 ? "t1" : "t2" }));
    mockRepo.questionsForClass = vi.fn(async () => mixed);
    const t2Ids = new Set(mixed.filter((q) => q.topic === "t2").map((q) => q.id));

    const code = await createSessionViaUi();

    const joiner = new StudyWsClient(`ws://127.0.0.1:${port}`);
    await joiner.connect();
    await joiner.joinSession(code, "uB", "Bob", [], []);
    const received: any[] = [];
    joiner.onMessage((m) => received.push(m));
    await waitForSessionStarted();

    /* Open the session browser and re-filter to topic t2 — the creator
       rebuilds the combined queue and re-broadcasts session_started. */
    fireEvent.click(screen.getByTitle("Browse session questions"));
    fireEvent.change(screen.getByLabelText("session topic filter"), {
      target: { value: "t2" },
    });

    await vi.waitFor(() => {
      const started = received.filter((m) => m.type === "session_started");
      expect(started.length).toBeGreaterThanOrEqual(2);
      const last = started[started.length - 1];
      expect(last.filter?.topic).toBe("t2");
      expect(last.questionIds.length).toBeGreaterThan(0);
      expect((last.questionIds as string[]).every((id: string) => t2Ids.has(id))).toBe(true);
    });
    joiner.disconnect();
  });

  it("algorithm mode serves the whole unit (no per-session new-card cap)", async () => {
    await setupWsClient();
    mockRepo = makeRepo();
    const many = makeQuestions(40);
    mockRepo.questionsForClass = vi.fn(async () => many);

    const code = await createSessionViaUi();

    const joiner = new StudyWsClient(`ws://127.0.0.1:${port}`);
    await joiner.connect();
    await joiner.joinSession(code, "uB", "Bob", [], []);
    const received: any[] = [];
    joiner.onMessage((m) => received.push(m));
    await waitForSessionStarted();

    /* All 40 questions reach the shared queue (3 due + 37 new, no cap). */
    expect(
      screen.getByText((_, el) => (el?.textContent ?? "").replace(/\s+/g, " ") === "Question 1 / 40"),
    ).toBeTruthy();
    await vi.waitFor(() => {
      const last = [...received].reverse().find((m) => m.type === "session_started");
      expect(last.questionIds.length).toBe(40);
    });
    joiner.disconnect();
  });

  it("browse mode (All units) puts every question in the shared queue", async () => {
    await setupWsClient();
    mockRepo = makeRepo();

    const code = await createSessionViaUi();

    const joiner = new StudyWsClient(`ws://127.0.0.1:${port}`);
    await joiner.connect();
    await joiner.joinSession(code, "uB", "Bob", [], []);
    const received: any[] = [];
    joiner.onMessage((m) => received.push(m));
    await waitForSessionStarted();

    /* Switch the unit filter from Algorithm to All units — browse mode
       deactivates the SRS pacing and sends the full pool. */
    fireEvent.click(screen.getByTitle("Browse session questions"));
    fireEvent.change(screen.getByLabelText("session unit filter"), {
      target: { value: "" },
    });

    await vi.waitFor(() => {
      const started = received.filter((m) => m.type === "session_started");
      expect(started.length).toBeGreaterThanOrEqual(2);
      const last = started[started.length - 1];
      expect(last.filter?.folderIds ?? []).toEqual([]);
      expect(last.questionIds.length).toBe(12);
    });

    /* In browse mode the creator gets a Shuffle button for the queue. */
    expect(screen.getByRole("button", { name: "Shuffle" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Shuffle" }));
    await vi.waitFor(() => {
      const started = received.filter((m) => m.type === "session_started");
      const last = started[started.length - 1];
      expect(last.questionIds.length).toBe(12);
      expect(new Set(last.questionIds).size).toBe(12);
    });
    joiner.disconnect();
  });
});
