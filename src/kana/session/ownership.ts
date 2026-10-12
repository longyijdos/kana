import { mkdirSync } from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";
import { errorCode } from "@/utils";
import type { KanaSessionMetadata } from "./format";

export class KanaSessionInUseError extends Error {
  constructor(sessionId: string) {
    super(`Kana session ${sessionId} is in use by another Kana conversation.`);
    this.name = "KanaSessionInUseError";
  }
}

class KanaSessionOwnershipLostError extends Error {
  constructor(sessionId: string, options: ErrorOptions) {
    super(`Kana session ${sessionId} lost its ownership lock; reload it to continue.`, options);
    this.name = "KanaSessionOwnershipLostError";
  }
}

export type KanaSessionOwnership = {
  assertOwned(): void;
  release(): void;
};

// The lock directory's mtime is refreshed while this process lives. A crashed
// owner stops refreshing it, so a later acquisition treats it as stale instead
// of blocking the session forever.
export function acquireKanaSessionOwnership(
  session: Pick<KanaSessionMetadata, "id" | "path">,
): KanaSessionOwnership {
  mkdirSync(path.dirname(session.path), { recursive: true });
  let lost: Error | undefined;
  let unlock: (() => void) | undefined;
  try {
    unlock = lockfile.lockSync(session.path, {
      realpath: false,
      onCompromised: (error) => {
        lost = error;
      },
    });
  } catch (error) {
    if (errorCode(error) === "ELOCKED") {
      throw new KanaSessionInUseError(session.id);
    }
    throw error;
  }

  return {
    assertOwned() {
      if (lost !== undefined) {
        throw new KanaSessionOwnershipLostError(session.id, { cause: lost });
      }
    },
    release() {
      const release = unlock;
      unlock = undefined;
      // proper-lockfile already forgot a compromised lock; unlocking it would
      // remove a directory that may now belong to another owner.
      if (release !== undefined && lost === undefined) {
        release();
      }
    },
  };
}
