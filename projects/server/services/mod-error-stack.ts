import type { Exception, StackFrame } from '@sentry/bun';
import { nn } from '../../shared/utils/type-assertion';

/**
 * The stack formats the mod's error reports carry: Mono's `Exception.ToString()` for every C#
 * report, and cohtml's V8-style `error.stack` for a UI report.
 */
export type ModStackFormat = 'mono' | 'cohtml';

interface FormatGrammar {
  readonly parseFrame: (line: string) => StackFrame | undefined;
  /**
   * Separates an exception's header from its inner exception's on the first line(s), outermost
   * first; each inner exception's frames end with {@link innerEnd}.
   */
  readonly innerSeparator?: string;
  readonly innerEnd?: string;
}

const grammars: Readonly<Record<ModStackFormat, FormatGrammar>> = {
  mono: {
    parseFrame: parseMonoFrame,
    innerSeparator: ' ---> ',
    innerEnd: '--- End of inner exception stack trace ---'
  },
  cohtml: {
    parseFrame: parseCohtmlFrame
  }
};

const framePrefix = /^\s+at /u;

// The IL offset in brackets, or the native one Mono writes for a frame without symbols.
const monoFrame =
  /^\s+at (?<method>.+?)(?: \[0x[\da-f]+\]| <0x[\da-f]+ \+ 0x[\da-f]+>)?(?: in (?<file>.+):(?<lineno>\d+))?$/u;

// `.ctor` and `.cctor` keep their leading dot; a wrapper frame has no type to split off.
const monoQualifiedMethod = /^(?<module>.+)\.(?<fn>\.?[^.\s(]+) ?\(.*\)$/su;

// A named function, or an anonymous one whose location stands alone.
const cohtmlFrame = /^\s+at (?:(?<fn>.+) \((?<named>.+)\)|(?<anonymous>.+))$/u;

const cohtmlPosition = /^(?<file>.+):(?<lineno>\d+):(?<colno>\d+)$/u;

/**
 * Parses a stack the mod sent into Sentry exceptions, innermost first as Sentry orders them, each
 * with its frames oldest first.
 * Returns `undefined` for a text not in `format`, which the caller passes on raw.
 * A text with no frame parses only as a single `Type: message` line, as Mono writes an exception
 * that was never thrown.
 */
export function parseModStack(format: ModStackFormat, text: string): Exception[] | undefined {
  const grammar = grammars[format];

  const lines = text
    .split(/\r?\n/u)
    .map(line => line.trimEnd())
    .filter(Boolean);

  const firstFrameIndex = lines.findIndex(line => framePrefix.test(line));

  if (firstFrameIndex == -1) {
    const [line, ...rest] = lines;

    return line != null && !rest.length ? [exceptionOf(line, [])] : undefined;
  }

  // Innermost exception first, as the runtime writes the innermost frames first.
  const segments: StackFrame[][] = [[]];

  for (const line of lines.slice(firstFrameIndex)) {
    if (grammar.innerEnd && line.trim() == grammar.innerEnd) {
      segments.push([]);
      continue;
    }

    const frame = grammar.parseFrame(line);

    if (!frame) {
      return undefined;
    }

    nn(segments.at(-1)).push(frame);
  }

  const header = lines.slice(0, firstFrameIndex).join('\n');

  const headers = grammar.innerSeparator ? header.split(grammar.innerSeparator) : [header];

  // A message holding the separator, or a frame line in a message, leaves them unpaired.
  if (headers.length != segments.length) {
    return undefined;
  }

  return headers
    .toReversed()
    .map((exceptionHeader, i) => exceptionOf(exceptionHeader, nn(segments[i])));
}

/**
 * Builds an exception from its `Type: message` header and its frames, newest first as the runtime
 * writes them.
 */
export function exceptionOf(
  header: string,
  frames: readonly StackFrame[]
): Exception & { readonly type: string } {
  const separatorIndex = header.indexOf(': ');

  const typeAndValue =
    separatorIndex == -1
      ? { type: header }
      : { type: header.slice(0, separatorIndex), value: header.slice(separatorIndex + 2) };

  return frames.length
    ? { ...typeAndValue, stacktrace: { frames: frames.toReversed() } }
    : typeAndValue;
}

/**
 * Parses a frame of Mono's text, `  at Namespace.Type.Method (args) [0x00001] in /path/File.cs:66`,
 * whose file reads `<module mvid>:0` outside the mod, the only assembly shipping its symbols.
 */
function parseMonoFrame(line: string): StackFrame | undefined {
  const match = monoFrame.exec(line);

  if (!match?.groups) {
    return undefined;
  }

  const { method = '', file, lineno } = match.groups;

  const qualified = monoQualifiedMethod.exec(method)?.groups;

  const location =
    file && !file.startsWith('<') ? { filename: file, abs_path: file, lineno: Number(lineno) } : {};

  return {
    function: qualified?.fn ?? method,
    ...(qualified?.module && { module: qualified.module }),
    ...location,
    in_app: /^HallOfFame[.+]/u.test(qualified?.module ?? '')
  };
}

/**
 * Parses a frame of cohtml's stack, `    at name (coui://ui-mods/HallOfFame.mjs:15:33308)` or, for
 * an anonymous function, `    at coui://ui-mods/HallOfFame.mjs:15:33420`.
 */
function parseCohtmlFrame(line: string): StackFrame | undefined {
  const match = cohtmlFrame.exec(line);

  if (!match?.groups) {
    return undefined;
  }

  const { fn, named, anonymous } = match.groups;

  const location = named ?? anonymous ?? '';

  const position = cohtmlPosition.exec(location)?.groups;

  const file = position?.file ?? location;

  return {
    function: fn ?? '?',
    filename: file,
    abs_path: file,
    ...(position && { lineno: Number(position.lineno), colno: Number(position.colno) }),
    in_app: file.startsWith('coui://ui-mods/HallOfFame')
  };
}
