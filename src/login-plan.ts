import { BrightspaceError } from './errors.js';

/** The services `npm run login` can connect, in the order it connects them. */
export const LOGIN_STEPS = ['brightspace', 'mytu', 'timetable'] as const;
export type LoginStep = (typeof LOGIN_STEPS)[number];

export interface LoginPlan {
  fresh: boolean;
  catalog: boolean;
  steps: Set<LoginStep>;
  /** True when --only was given, so a named step was explicitly requested. */
  only: boolean;
}

/**
 * Parse `login` options. Unknown options and unknown `--only` services fail
 * loudly: a typo such as `--only timetables` must not look like a successful
 * login that quietly skipped everything the student asked for.
 */
export function parseLoginArgs(args: readonly string[]): LoginPlan {
  const list = `--only needs a comma-separated list of: ${LOGIN_STEPS.join(', ')}.`;
  let fresh = false, catalog = false, only: string[] | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--fresh') { fresh = true; continue; }
    if (arg === '--catalog') { catalog = true; continue; }
    if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg === '--only' ? args[++index] : arg.slice('--only='.length);
      if (value === undefined || value.startsWith('-') || !value.trim()) throw new BrightspaceError('INVALID_ARGUMENT', list);
      only = value.split(',').map(step => step.trim().toLowerCase()).filter(Boolean);
      if (!only.length) throw new BrightspaceError('INVALID_ARGUMENT', list);
      continue;
    }
    throw new BrightspaceError('INVALID_ARGUMENT', `Unknown login option "${arg}". Use --fresh, --catalog or --only.`);
  }
  const unknown = (only ?? []).filter(step => !(LOGIN_STEPS as readonly string[]).includes(step));
  if (unknown.length) throw new BrightspaceError('INVALID_ARGUMENT', `Unknown --only service: ${unknown.join(', ')}. Choose from: ${LOGIN_STEPS.join(', ')}.`);
  if (catalog && only) throw new BrightspaceError('INVALID_ARGUMENT', '--catalog signs in to the Brightspace catalog only and cannot be combined with --only.');
  return { fresh, catalog, only: only !== undefined,
    steps: new Set<LoginStep>(catalog ? ['brightspace'] : only?.length ? only as LoginStep[] : LOGIN_STEPS) };
}
