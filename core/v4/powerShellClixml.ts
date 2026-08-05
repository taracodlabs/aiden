/** Remove only structured PowerShell progress objects from a CLIXML document. */
export function filterPowerShellProgressClixml(value: string): { stderr: string; removedProgress: boolean } {
  const text = value.trim();
  const document = /^(#< CLIXML\s*)(<Objs\b[^>]*>)([\s\S]*)(<\/Objs>)$/u.exec(text);
  if (!document) return { stderr: value, removedProgress: false };
  const body = document[3] ?? '';
  const filtered = body.replace(/<Obj\b(?=[^>]*\bS="progress")[^>]*>[\s\S]*?<\/Obj>/gu, '');
  if (filtered === body) return { stderr: value, removedProgress: false };
  if (!filtered.trim()) return { stderr: '', removedProgress: true };
  return {
    stderr: `${document[1] ?? '#< CLIXML\n'}${document[2] ?? '<Objs>'}${filtered}${document[4] ?? '</Objs>'}`,
    removedProgress: true,
  };
}
