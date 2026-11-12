/** Choose a model for this regeneration without changing the source selection. */
import { useMemo, useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { MessageEditState } from '../contract/store.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './RegenerationModelSelector.module.css'

interface ModelSelectorProps {
  directory: ModelDirectoryState
  selected: MessageEditState['modelSelection']
  busy: boolean
  onChange: (selection: MessageEditState['modelSelection']) => void
  reload: () => void
  t: ChatViewSlotProps['t']
}
export function RegenerationModelSelector({ directory, selected, busy, onChange, reload, t }: ModelSelectorProps) {
  const [query, setQuery] = useState('')
  const selectedKey = selected === undefined ? '' : JSON.stringify(selected)
  const groups = useMemo(() => directory.groups.map(group => ({ ...group,
    models: group.models.filter(model => !query || model.name.toLowerCase().includes(query.toLowerCase())
      || model.id.toLowerCase().includes(query.toLowerCase())
      || (selected?.provider === group.id && selected.model === model.id)),
  })).filter(group => group.models.length), [directory.groups, query, selected])
  const current = directory.current
  const currentName = directory.groups.find(group => group.id === current?.provider)?.models
    .find(model => model.id === current?.model)?.name ?? current?.model
  return <div className={css.root}>
    <label className={css.label}>{t('message.edit.model')}
      <select className={css.select} aria-label={t('message.edit.model')} value={selectedKey} disabled={busy}
        onChange={event => {
          const key = event.target.value
          const found = directory.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })))
            .find(choice => JSON.stringify(choice) === key)
          onChange(found)
        }}>
        <option value="">{t('message.edit.currentModel')}{currentName ? `: ${currentName}` : ''}</option>
        {groups.map(group => <optgroup key={group.id} label={group.name}>
          {group.models.map(model => <option key={model.id} value={JSON.stringify({ provider: group.id, model: model.id })}>{model.name}</option>)}
        </optgroup>)}
      </select>
    </label>
    {directory.groups.reduce((count, group) => count + group.models.length, 0) > 12 && <Input
      value={query} onChange={event => setQuery(event.target.value)} placeholder={t('message.edit.filterModels')}
      aria-label={t('message.edit.filterModels')} disabled={busy} />}
    {directory.status === 'loading' && <span className={css.note} role="status">{t('message.edit.loadingModels')}</span>}
    {(directory.error || directory.failures.length > 0) && <div className={css.note} role="status">
      {t('message.edit.modelsFailed')} <button type="button" onClick={reload} disabled={busy}>{t('message.edit.retryModels')}</button>
    </div>}
  </div>
}
