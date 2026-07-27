import { describe, it, expect } from 'vitest';
import { parseStream } from '../src/stream/parse.js';
import { makeSave, writeSave, readSave, listSaves, deleteSave, memoryStore, SAVE_FORMAT, SAVE_VERSION } from '../src/ui/storage.js';

const sample = 'e1 d5m 123456789m1234z1z ? ? ? 1z 9p 8p ryuukyoku';

describe('local save/load', () => {
  it('round-trips the game model and stream text', () => {
    const st = memoryStore();
    const { game } = parseStream(sample);
    const rec = makeSave(game, sample, { id: 'rec1', savedAt: 1000, title: 'My game' });
    writeSave(rec, st);

    const back = readSave('rec1', st)!;
    expect(back.format).toBe(SAVE_FORMAT);
    expect(back.version).toBe(SAVE_VERSION);
    expect(back.title).toBe('My game');
    expect(back.stream).toBe(sample);
    expect(back.game.kyokus.length).toBe(game.kyokus.length);
    expect(back.game.kyokus[0].players[0].haipai).toEqual(game.kyokus[0].players[0].haipai);
  });

  it('titles default from the game meta, then to a placeholder', () => {
    const { game } = parseStream(sample);
    expect(makeSave(game, sample).title).toBe(game.meta.title[0]);
    const untitled = { ...game, meta: { ...game.meta, title: ['  '] } };
    expect(makeSave(untitled, sample).title).toBe('Untitled game');
  });

  it('overwrites a slot on re-save (same id) and lists newest first', () => {
    const st = memoryStore();
    const { game } = parseStream(sample);
    writeSave(makeSave(game, sample, { id: 'a', savedAt: 10, title: 'A' }), st);
    writeSave(makeSave(game, sample, { id: 'b', savedAt: 20, title: 'B' }), st);
    writeSave(makeSave(game, sample, { id: 'a', savedAt: 30, title: 'A2' }), st); // overwrite a

    const metas = listSaves(st);
    expect(metas.map((m) => m.id)).toEqual(['a', 'b']); // a is newest after re-save
    expect(metas[0].title).toBe('A2');
  });

  it('deletes a save', () => {
    const st = memoryStore();
    const { game } = parseStream(sample);
    writeSave(makeSave(game, sample, { id: 'x', savedAt: 1 }), st);
    deleteSave('x', st);
    expect(readSave('x', st)).toBeNull();
    expect(listSaves(st)).toEqual([]);
  });

  it('ignores foreign / corrupt entries', () => {
    const st = memoryStore();
    st.setItem('paifuplus:save:bad', '{not json');
    st.setItem('paifuplus:save:foreign', JSON.stringify({ format: 'other', game: { kyokus: [] } }));
    st.setItem('unrelated', 'x');
    expect(listSaves(st)).toEqual([]);
    expect(readSave('bad', st)).toBeNull();
  });
});
