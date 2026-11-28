/**
 * Conversation threads for the RPC ask path.
 *
 * The streaming query endpoint is stateless: a follow-up only knows what came
 * before if the caller sends the earlier turns back with it. So the thread
 * lives here, keyed by the caller's `session_id` (the conversation id of the
 * first answer when the caller named none), and every follow-up replays it. Because each thread carries its own history,
 * several threads on one notebook stay independent of each other — something
 * the web UI, with its single conversation per notebook, does not offer.
 *
 * Wire shape of the replayed history (oldest turn first, the answer of a turn
 * before its question) from teng-lin/notebooklm-py
 * `_web/chat.py::_build_history_from_turns` (MIT).
 *
 * Held in memory: a restart forgets every thread, and a follow-up naming a
 * forgotten id starts that thread afresh (the answer reports `message_count: 1`).
 */

export interface ConversationTurn {
  question: string;
  answer: string;
}

export interface ConversationThread {
  /** The caller-facing id: the `session_id` of the ask. */
  id: string;
  notebookId: string;
  /** The id NotebookLM gave the conversation, sent back on every follow-up. */
  conversationId: string;
  turns: ConversationTurn[];
  createdAt: number;
  lastActivity: number;
}

/** Distinct threads kept; the least recently used is dropped beyond this. */
export const MAX_THREADS = 100;
/** Turns kept per thread; the oldest are dropped first. */
export const MAX_TURNS_PER_THREAD = 50;

export class ConversationStore {
  private readonly threads = new Map<string, ConversationThread>();

  constructor(
    private readonly maxThreads = MAX_THREADS,
    private readonly maxTurns = MAX_TURNS_PER_THREAD
  ) {}

  /** The thread, marked most recently used, or undefined. */
  get(id: string): ConversationThread | undefined {
    const thread = this.threads.get(id);
    if (thread) {
      this.threads.delete(id);
      this.threads.set(id, thread);
    }
    return thread;
  }

  has(id: string): boolean {
    return this.threads.has(id);
  }

  /**
   * Append one answered turn, creating the thread on its first turn. A thread
   * id reused on another notebook starts over: the earlier turns answered from
   * other sources and would mislead the follow-up.
   */
  record(
    id: string,
    notebookId: string,
    conversationId: string,
    turn: ConversationTurn,
    now = Date.now()
  ): ConversationThread {
    const existing = this.get(id);
    const thread =
      existing && existing.notebookId === notebookId
        ? existing
        : { id, notebookId, conversationId, turns: [], createdAt: now, lastActivity: now };
    thread.conversationId = conversationId;
    thread.turns.push(turn);
    if (thread.turns.length > this.maxTurns) {
      thread.turns.splice(0, thread.turns.length - this.maxTurns);
    }
    thread.lastActivity = now;
    this.threads.set(id, thread);
    while (this.threads.size > this.maxThreads) {
      const oldest = this.threads.keys().next().value as string;
      this.threads.delete(oldest);
    }
    return thread;
  }

  /** Forget the thread's turns but keep its id usable. False if unknown. */
  reset(id: string): boolean {
    const thread = this.threads.get(id);
    if (!thread) return false;
    thread.turns = [];
    thread.lastActivity = Date.now();
    return true;
  }

  delete(id: string): boolean {
    return this.threads.delete(id);
  }

  list(): ConversationThread[] {
    return [...this.threads.values()];
  }
}

/** The history array the query endpoint expects, or null for a first turn. */
export function buildQueryHistory(turns: readonly ConversationTurn[]): unknown[] | null {
  if (turns.length === 0) return null;
  const history: unknown[] = [];
  for (const turn of turns) {
    history.push([turn.answer, null, 2]);
    history.push([turn.question, null, 1]);
  }
  return history;
}
