/** In-place message editor: multiline draft with Save / Cancel / Save and fork. */
import { Button, InlineEditor } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { MessageEditOutcome } from '../contract/store.ts'
import css from './MessageEditPanel.module.css'
import { RegenerationModelSelector } from './RegenerationModelSelector.tsx'

export interface MessageEditPanelProps {
  /** Current draft text. */
  draft: string
  /** A save or save-and-fork attempt is in flight. */
  busy: boolean
  /** Whether the peer may commit edits on this session. */
  canEdit: boolean
  /** Whether the peer may fork this session. */
  canFork: boolean
  /** Transient outcome of the latest failed attempt. */
  outcome: MessageEditOutcome | undefined
  /** Receives the edited draft text. */
  onChange: (text: string) => void
  /** Discard the draft and close the editor. */
  onCancel: () => void
  /** Commit the draft into this session. */
  onSave: () => void
  /** Fork the session at this message and commit the draft into the child. */
  onSaveAndFork: () => void
  /** Label for the primary action; user edits regenerate in a fork. */
  saveLabel?: string
  hideFork?: boolean
  /** User-only model choice, read from the shared directory. */
  modelPicker?: Parameters<typeof RegenerationModelSelector>[0]
  /** Parent layout class composed onto the panel root. */
  className?: string | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Render the one open message editor for its row. Enter saves, Shift+Enter
 * breaks the line, Enter during IME composition does nothing, and Escape
 * cancels — the InlineEditor conventions. Save stays disabled on an
 * empty/whitespace draft; busy disables both commit paths.
 * @param props - draft, capability, outcome, gesture callbacks, and locale seat.
 * @returns the editor panel.
 */
export function MessageEditPanel({
  draft, busy, canEdit, canFork, outcome, onChange, onCancel, onSave, onSaveAndFork, className, t, saveLabel, hideFork, modelPicker,
}: MessageEditPanelProps) {
  const valid = draft.trim() !== ''
  const saveDisabled = busy || !valid || !canEdit
  const forkDisabled = busy || !valid || !canFork
  const notice = outcome === undefined ? null
    : outcome.kind === 'conflict' ? t('message.edit.conflict')
      : outcome.kind === 'busy' ? t('message.edit.busy')
        : outcome.kind === 'invalidTarget' ? t('message.edit.invalidTarget')
          : outcome.kind === 'unconfirmed' ? t('message.edit.unconfirmed')
            : outcome.kind === 'failed' ? t('message.edit.failed')
               : outcome.kind === 'forkFailed' ? t('message.edit.forkFailed')
                 : outcome.kind === 'operationError' ? outcome.message : t('message.edit.partialFork')
  return (
    <div className={className === undefined ? css.panel : `${css.panel} ${className}`} data-message-edit-panel="">
      {modelPicker && <RegenerationModelSelector {...modelPicker} />}
      <InlineEditor
        value={draft}
        label={t('message.edit')}
        onChange={(text) => { if (!busy) onChange(text) }}
        onSave={() => { if (!saveDisabled) onSave() }}
        onCancel={() => { if (!busy) onCancel() }}
        {...css.editor === undefined ? {} : { className: css.editor }}
      />
      {notice !== null && (
        <span className={css.notice} role="status" data-outcome={outcome?.kind}>
          {notice}
          {(outcome?.kind === 'partialFork' || outcome?.kind === 'operationError') && outcome.childSessionId && <span className={css.noticeDetail}>{outcome.childSessionId}</span>}
        </span>
      )}
      <div className={css.controls}>
        <Button size="sm" variant="primary" disabled={saveDisabled} onClick={onSave}>
          {busy ? t('message.edit.saving') : saveLabel ?? t('message.edit.save')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          {t('message.edit.cancel')}
        </Button>
        {!hideFork && <Button size="sm" variant="ghost" disabled={forkDisabled} onClick={onSaveAndFork}>
          {t('message.edit.saveAndFork')}
        </Button>}
      </div>
    </div>
  )
}
