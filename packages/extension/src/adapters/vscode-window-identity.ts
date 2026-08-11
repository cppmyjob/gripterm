import * as vscode from 'vscode';
import { OwnerId, identifyWindow } from '@gripterm/core';
import type { IdGenerator, OwnerIdentity } from '@gripterm/core';

/**
 * This window's identity, read from the editor rather than guessed.
 *
 * Every decision about what the readings MEAN is on the other side of
 * `identifyWindow`; what is left here is which four values to read.
 *
 * The owner id is minted, not taken from `vscode.env.sessionId`. The host's own
 * per-session string would be nicer to read in a log, but whether two windows of
 * one editor share it is UNMEASURED -- and a shared owner id is two windows
 * claiming the same terminals, then both running `claude --resume` on one
 * conversation. A drawn uuid cannot collide by construction, which is the
 * property that matters here.
 */
export function windowIdentity(ids: IdGenerator): OwnerIdentity {
  return identifyWindow({
    ownerId: OwnerId.fromString(ids.newUuid()),
    appName: vscode.env.appName,
    editorVersion: vscode.version,
    // The extension host's process, which is what M2.12 will ask the system
    // about when deciding whether an owner is still there.
    pid: process.pid,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
      (folder) => folder.uri.fsPath
    ),
  });
}
