export function firstGrapheme(value: string): string | undefined {
  return graphemeSegments(value)[0]?.segment;
}

export function graphemeSegments(
  value: string,
): Array<{ segment: string; index: number }> {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale: string,
        options: { granularity: "grapheme" },
      ) => {
        segment(value: string): Iterable<{ segment: string; index: number }>;
      };
    }
  ).Segmenter;

  if (Segmenter) {
    return Array.from(
      new Segmenter("en", { granularity: "grapheme" }).segment(value),
      (segment) => ({
        segment: segment.segment,
        index: segment.index,
      }),
    );
  }

  let index = 0;

  return Array.from(value, (segment) => {
    const current = {
      segment,
      index,
    };
    index += segment.length;

    return current;
  });
}
