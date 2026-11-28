/**
 * Conversation threads of the RPC ask path (no network).
 *
 * The query endpoint keeps no state: a follow-up recalls only what is sent
 * back with it. These lock the replayed wire shape and the store's bounds.
 */
import { describe, it, expect } from '@jest/globals';
import { ConversationStore, buildQueryHistory } from '../rpc/conversation-store.js';

describe('buildQueryHistory', () => {
  it('is null for a first turn', () => {
    expect(buildQueryHistory([])).toBeNull();
  });

  it('replays turns oldest first, each answer before its question', () => {
    expect(
      buildQueryHistory([
        { question: 'q1', answer: 'a1' },
        { question: 'q2', answer: 'a2' },
      ])
    ).toEqual([
      ['a1', null, 2],
      ['q1', null, 1],
      ['a2', null, 2],
      ['q2', null, 1],
    ]);
  });
});

describe('ConversationStore', () => {
  it('appends turns to one thread and keeps the latest server conversation id', () => {
    const store = new ConversationStore();
    store.record('t1', 'nb', 'conv-a', { question: 'q1', answer: 'a1' }, 1000);
    const t = store.record('t1', 'nb', 'conv-b', { question: 'q2', answer: 'a2' }, 5000);
    expect(t.turns.map((x) => x.question)).toEqual(['q1', 'q2']);
    expect(t.conversationId).toBe('conv-b');
    expect(t.createdAt).toBe(1000);
    expect(t.lastActivity).toBe(5000);
  });

  it('keeps threads on one notebook independent', () => {
    const store = new ConversationStore();
    store.record('a', 'nb', 'c1', { question: 'qa', answer: 'aa' });
    store.record('b', 'nb', 'c2', { question: 'qb', answer: 'ab' });
    expect(store.get('a')!.turns).toEqual([{ question: 'qa', answer: 'aa' }]);
    expect(store.get('b')!.turns).toEqual([{ question: 'qb', answer: 'ab' }]);
  });

  it('starts a thread over when its id is reused on another notebook', () => {
    const store = new ConversationStore();
    store.record('t', 'nb-1', 'c1', { question: 'q1', answer: 'a1' });
    const t = store.record('t', 'nb-2', 'c2', { question: 'q2', answer: 'a2' });
    expect(t.notebookId).toBe('nb-2');
    expect(t.turns).toEqual([{ question: 'q2', answer: 'a2' }]);
  });

  it('drops the oldest turns beyond the per-thread cap', () => {
    const store = new ConversationStore(10, 2);
    for (const n of [1, 2, 3]) store.record('t', 'nb', 'c', { question: `q${n}`, answer: `a${n}` });
    expect(store.get('t')!.turns.map((x) => x.question)).toEqual(['q2', 'q3']);
  });

  it('evicts the least recently used thread beyond the thread cap', () => {
    const store = new ConversationStore(2);
    store.record('a', 'nb', 'c', { question: 'q', answer: 'a' });
    store.record('b', 'nb', 'c', { question: 'q', answer: 'a' });
    store.get('a'); // touch: b is now the least recently used
    store.record('c', 'nb', 'c', { question: 'q', answer: 'a' });
    expect(store.has('a')).toBe(true);
    expect(store.has('b')).toBe(false);
    expect(store.has('c')).toBe(true);
  });

  it('reset empties a thread but keeps it; delete forgets it', () => {
    const store = new ConversationStore();
    store.record('t', 'nb', 'c', { question: 'q', answer: 'a' });
    expect(store.reset('t')).toBe(true);
    expect(store.get('t')!.turns).toEqual([]);
    expect(store.delete('t')).toBe(true);
    expect(store.has('t')).toBe(false);
    expect(store.reset('t')).toBe(false);
  });
});
