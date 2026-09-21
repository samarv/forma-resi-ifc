/**
 * The room graph: adjacency (rooms sharing a wall) and connectivity (rooms sharing a door or cased opening).
 *
 * v1 built this information while cutting doors and then threw it away, so no rule could ask "is the bathroom entered
 * from the hall?" or "does one have to walk through a bedroom to reach the balcony?". It is now persisted, built once
 * from `ArchModel.walls` / `ArchModel.doors`, and read by the `adjacent` / `connected` / `notThrough` predicates and
 * (in wave 2) by the program solver.
 *
 * Deterministic: every adjacency list is sorted by room id, so BFS visits neighbours in a canonical order.
 */
import type { ArchModel, DoorDef, WallDef } from '../types.ts';
import type { RoomGraph } from './types.ts';

export interface RoomGraphInput {
  walls: readonly WallDef[];
  doors: readonly DoorDef[];
}

function push(m: Map<string, Set<string>>, a: string, b: string): void {
  if (a === b) return;
  let s = m.get(a);
  if (!s) {
    s = new Set<string>();
    m.set(a, s);
  }
  s.add(b);
}

function sortedLists(m: Map<string, Set<string>>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, v] of m) out.set(k, [...v].sort());
  return out;
}

export function buildRoomGraph(i: RoomGraphInput): RoomGraph {
  const adj = new Map<string, Set<string>>();
  const con = new Map<string, Set<string>>();

  for (const w of i.walls) {
    if (!w.leftRoomId || !w.rightRoomId) continue;
    push(adj, w.leftRoomId, w.rightRoomId);
    push(adj, w.rightRoomId, w.leftRoomId);
  }
  for (const d of i.doors) {
    if (!d.fromRoomId || !d.toRoomId) continue;
    push(con, d.fromRoomId, d.toRoomId);
    push(con, d.toRoomId, d.fromRoomId);
    // A door also implies the two rooms share a wall, even if the wall records only one side.
    push(adj, d.fromRoomId, d.toRoomId);
    push(adj, d.toRoomId, d.fromRoomId);
  }

  const adjacent = sortedLists(adj);
  const connected = sortedLists(con);
  const EMPTY: readonly string[] = [];

  const bfs = (a: string, b: string): string[] | null => {
    if (a === b) return [a];
    const prev = new Map<string, string>();
    const queue: string[] = [a];
    const seen = new Set<string>([a]);
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      for (const nb of connected.get(cur) ?? EMPTY) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        prev.set(nb, cur);
        if (nb === b) {
          const path = [b];
          let walk = b;
          while (walk !== a) {
            walk = prev.get(walk) as string;
            path.push(walk);
          }
          return path.reverse();
        }
        queue.push(nb);
      }
    }
    return null;
  };

  return {
    adjacent(roomId: string): readonly string[] {
      return adjacent.get(roomId) ?? EMPTY;
    },
    connected(roomId: string): readonly string[] {
      return connected.get(roomId) ?? EMPTY;
    },
    path(a: string, b: string): readonly string[] | null {
      return bfs(a, b);
    },
    through(a: string, b: string): readonly string[] {
      const p = bfs(a, b);
      return p ? p.slice(1, Math.max(1, p.length - 1)) : EMPTY;
    },
  };
}

export function roomGraphOf(arch: ArchModel | null): RoomGraph {
  return buildRoomGraph({ walls: arch?.walls ?? [], doors: arch?.doors ?? [] });
}

export const EMPTY_ROOM_GRAPH: RoomGraph = buildRoomGraph({ walls: [], doors: [] });
