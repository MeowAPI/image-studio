import { useTranslation } from 'react-i18next'
import { UserRound, Save, Info, X } from 'lucide-react'

export default function StudioAccountNotice({ compact = false, onDismiss }: { compact?: boolean; onDismiss?: () => void }) {
  const { t } = useTranslation()
  return (
    <section className={compact ? 'studio-key-warning is-compact' : 'studio-key-warning'} role="note" aria-label={t('imageStudioPortal.historyWarning.title')}>
      <span className="studio-key-warning-icon" aria-hidden="true"><Info /></span>
      <div className="studio-key-warning-body">
        <p className="studio-key-warning-head"><span className="studio-key-warning-badge">{t('imageStudioPortal.historyWarning.badge')}</span><strong>{t('imageStudioPortal.historyWarning.title')}</strong></p>
        <ul className="studio-key-warning-list">
          <li><UserRound aria-hidden="true" /><span>{t('imageStudioPortal.historyWarning.keyNotice')}</span></li>
          <li><Save aria-hidden="true" /><span>{t('imageStudioPortal.historyWarning.saveNotice')}</span></li>
        </ul>
      </div>
      {onDismiss && <button type="button" className="studio-key-warning-dismiss" onClick={onDismiss} aria-label={t('imageStudioPortal.historyWarning.dismiss')} title={t('imageStudioPortal.historyWarning.dismissHint')}><X aria-hidden="true" /></button>}
    </section>
  )
}
