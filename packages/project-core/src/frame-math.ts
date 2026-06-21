import { reduceRational } from './schema.js';

export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

export type RoundingMode = 'floor' | 'ceil' | 'nearest';

function divide(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n || mode === 'floor') return quotient;
  if (mode === 'ceil') return quotient + 1n;
  return remainder * 2n < denominator ? quotient : quotient + 1n;
}

function toSafeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new RangeError('Frame calculation exceeds safe integer range');
  return number;
}

export function secondsToFrames(
  seconds: number,
  fps: Rational,
  mode: RoundingMode = 'nearest',
): number {
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new RangeError('Seconds must be finite and nonnegative');
  const microseconds = BigInt(Math.round(seconds * 1_000_000));
  return toSafeNumber(
    divide(
      microseconds * BigInt(fps.numerator),
      1_000_000n * BigInt(fps.denominator),
      mode,
    ),
  );
}

export function framesToSeconds(frames: number, fps: Rational): number {
  if (!Number.isSafeInteger(frames) || frames < 0)
    throw new RangeError('Frames must be nonnegative');
  return (frames * fps.denominator) / fps.numerator;
}

export function rescaleFrames(
  frames: number,
  sourceFps: Rational,
  targetFps: Rational,
  mode: RoundingMode = 'nearest',
): number {
  if (!Number.isSafeInteger(frames) || frames < 0)
    throw new RangeError('Frames must be nonnegative');
  return toSafeNumber(
    divide(
      BigInt(frames) *
        BigInt(sourceFps.denominator) *
        BigInt(targetFps.numerator),
      BigInt(sourceFps.numerator) * BigInt(targetFps.denominator),
      mode,
    ),
  );
}

export function clipDurationFrames(
  sourceIn: number,
  sourceOut: number,
  speed: Rational,
): number {
  if (sourceOut <= sourceIn)
    throw new RangeError('sourceOut must be greater than sourceIn');
  return toSafeNumber(
    divide(
      BigInt(sourceOut - sourceIn) * BigInt(speed.denominator),
      BigInt(speed.numerator),
      'ceil',
    ),
  );
}

export function framesToTimecode(frames: number, fps: Rational): string {
  if (!Number.isSafeInteger(frames) || frames < 0)
    throw new RangeError('Frames must be nonnegative');
  const nominalFps = Math.ceil(fps.numerator / fps.denominator);
  const frame = frames % nominalFps;
  const totalSeconds = Math.floor(frames / nominalFps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, seconds, frame]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function multiplyRationals(left: Rational, right: Rational): Rational {
  return reduceRational(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );
}
