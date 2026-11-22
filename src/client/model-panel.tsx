/**
 * Model picker: choose the provider/model used for side questions.
 *
 * Default is "follow the main conversation" (the host infers the route from the
 * conversation's last assistant message). The catalog is loaded lazily from
 * `GET /models`; adapters that advertise no models leave the picker with only the
 * "follow" option, which is still a valid state.
 */

import { useEffect } from 'react'

import type { SideAskStore, UiState } from './store.js'

export interface ModelPanelProps {
  store: SideAskStore
  state: UiState
  onClose: () => void
}

export function ModelPanel({ store, state, onClose }: ModelPanelProps): React.ReactElement {
  useEffect(() => {
    void store.loadModels()
  }, [store])

  const override = state.modelOverride
  const catalog = state.modelCatalog
  const totalModels = catalog === null ? 0 : catalog.reduce((sum, provider) => sum + provider.models.length, 0)

  return (
    <div className="sa-menu" data-testid="sideask-model-panel">
      <div className="sa-menu-head">
        <span>模型</span>
        <span className="sa-menu-count">{override === null ? '跟随主对话' : '已指定'}</span>
      </div>
      <div className="sa-menu-list">
        <button
          type="button"
          className="sa-menu-item"
          data-active={override === null}
          onClick={() => {
            store.setModelOverride(null)
            onClose()
          }}
        >
          <span className="sa-menu-title">跟随主对话（默认）</span>
          <span className="sa-menu-meta">使用主对话当前使用的 provider/model</span>
        </button>
        {catalog === null ? (
          <div className="sa-menu-empty">正在读取可用模型…</div>
        ) : totalModels === 0 ? (
          <div className="sa-menu-empty">
            {catalog.length === 0 ? '宿主没有暴露可选模型列表（可继续跟随主对话）' : '宿主的模型适配器没有公开模型清单（可继续跟随主对话）'}
            {state.modelCatalogError === null ? '' : `：${state.modelCatalogError}`}
          </div>
        ) : (
          catalog.map((provider) =>
            provider.models.map((model) => {
              const active = override !== null && override.provider === provider.provider && override.model === model.id
              return (
                <button
                  key={`${provider.provider}/${model.id}`}
                  type="button"
                  className="sa-menu-item"
                  data-active={active}
                  title={`${provider.provider}/${model.id}`}
                  onClick={() => {
                    store.setModelOverride(provider.provider, model.id)
                    onClose()
                  }}
                >
                  <span className="sa-menu-title">{model.name}</span>
                  <span className="sa-menu-meta">{provider.provider}</span>
                </button>
              )
            }),
          )
        )}
      </div>
      <div className="sa-hint" style={{ marginTop: 6 }}>
        只影响旁问这一侧；不会改动主对话或宿主设置。
      </div>
    </div>
  )
}
