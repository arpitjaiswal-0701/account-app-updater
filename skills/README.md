# Skills — versioned copies

These are version-controlled copies of the two Claude Code skills that drive this tool:

- `ghosthand/SKILL.md` — `/ghosthand <account> [context]` — spot-update ONE account.
- `ghosthand-all/SKILL.md` — `/ghosthand-all [subset]` — bulk weekly-remark sweep.

## Authoritative location

The **installed** (executing) copies live at:

```
~/.claude/skills/ghosthand/SKILL.md
~/.claude/skills/ghosthand-all/SKILL.md
```

Claude Code loads the skills from there, **not** from this repo. The copies here are a
backup / change history only.

## Keep them in sync

When you edit a skill, update **both** places, or copy across after editing:

```bash
# repo -> installed (deploy an edit made here)
cp skills/ghosthand/SKILL.md       ~/.claude/skills/ghosthand/SKILL.md
cp skills/ghosthand-all/SKILL.md   ~/.claude/skills/ghosthand-all/SKILL.md

# installed -> repo (back up an edit made live)
cp ~/.claude/skills/ghosthand/SKILL.md      skills/ghosthand/SKILL.md
cp ~/.claude/skills/ghosthand-all/SKILL.md  skills/ghosthand-all/SKILL.md
```
