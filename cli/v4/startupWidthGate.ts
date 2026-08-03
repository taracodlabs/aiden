/** One-shot width gate shared by interactive startup and first-run setup. */
export async function waitForStartupWidth(options: {
  out: NodeJS.WriteStream;
  minimum: number;
  currentColumns: () => number;
  requirementLines: readonly string[];
}): Promise<boolean> {
  const { out, minimum, currentColumns, requirementLines } = options;
  if (!out.isTTY || currentColumns() >= minimum) return false;

  out.write(`\x1b[2J\x1b[H${requirementLines.join('\n')}\n`);
  const keepAlive = setInterval(() => undefined, 60_000);
  try {
    await new Promise<void>((resolve) => {
      const onResize = (): void => {
        if (currentColumns() < minimum) return;
        out.off('resize', onResize);
        resolve();
      };
      out.on('resize', onResize);
      onResize();
    });
  } finally {
    clearInterval(keepAlive);
  }
  out.write('\x1b[2J\x1b[H');
  return true;
}
