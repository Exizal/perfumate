import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commit, loadAll, openDatabase, replaceAll } from '../src/store/db';
import { applyChangeset, emptyState } from '../src/domain/types';
import { buildDemo } from '../src/domain/demo';
import { buildBackup, backupToState, integrityProblems, parseBackup } from '../src/domain/backup';
import { lotBalance, recordAddition } from '../src/domain/batch';
import { parseLabelPayload } from '../src/domain/ids';
import { canon } from '../src/domain/decimal';

describe('IndexedDB persistence', () => {
  it('survives close/reopen, keeps labels resolvable, and restores a backup exactly', async () => {
    const db = await openDatabase('test-db-1');
    const cs = buildDemo(emptyState(), new Date('2026-10-28T12:00:00Z'));
    await commit(db, cs);
    db.close();

    const db2 = await openDatabase('test-db-1');
    const loaded = await loadAll(db2);
    const b18 = Object.values(loaded.batches).find((b) => b.code === 'AT-B018')!;
    expect(loaded.batches[parseLabelPayload(`MBLJ:batch:${b18.id}:AT-B018`).batchId!].revisionCode).toBe('AT-F002');
    expect(integrityProblems(loaded)).toEqual([]);

    // retrying an addition after reload does not double-decrement
    const evId = Object.values(loaded.weighEvents).find((e) => e.batchId === b18.id && e.lotId)!;
    const lotId = evId.lotId!;
    const before = lotBalance(loaded, lotId)!;
    await commit(db2, recordAddition(loaded, { batchId: b18.id, lineId: evId.lineId, mass: evId.mass, lotId, idempotencyKey: evId.id }));
    expect(canon(lotBalance(await loadAll(db2), lotId)!)).toBe(canon(before));

    const backupText = JSON.stringify(buildBackup(loaded, '2026-10-28T13:00:00Z'));
    await replaceAll(db2, emptyState());
    expect(Object.keys((await loadAll(db2)).batches)).toHaveLength(0);
    await replaceAll(db2, backupToState(parseBackup(backupText)));
    const restored = await loadAll(db2);
    expect(Object.keys(restored.observations).length).toBe(Object.keys(loaded.observations).length);
    expect(restored.batches[b18.id].code).toBe('AT-B018');
    expect(restored.settings.lastBackupAt).toBe('2026-10-28T13:00:00Z');
    db2.close();
  });

  it('applyChangeset and the database agree', async () => {
    const db = await openDatabase('test-db-2');
    const cs = buildDemo(emptyState());
    await commit(db, cs);
    const mem = applyChangeset(emptyState(), cs);
    const disk = await loadAll(db);
    expect(Object.keys(disk.inventoryTx).sort()).toEqual(Object.keys(mem.inventoryTx).sort());
    db.close();
  });
});
