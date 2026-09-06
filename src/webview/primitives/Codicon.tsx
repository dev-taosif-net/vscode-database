interface Props {
  name: string;
  /** Decorative by default; give a label only when the icon is the whole message. */
  label?: string;
  className?: string;
  spin?: boolean;
}

/**
 * A VS Code codicon. The font ships with the extension, so the icon set is the
 * one the workbench itself draws and needs no network.
 */
export function Codicon({ name, label, className, spin }: Props) {
  const classes = ['codicon', `codicon-${name}`, spin ? 'codicon-modifier-spin' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={classes}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
