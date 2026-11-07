export interface ConnectorStatus {
  provider: string
  label: string
  configured: boolean
  detail: string
}

export interface ConnectorActionDraft {
  account: string
  kind: string
  target: string
  message: string
  payload: Record<string, unknown>
}

export interface StoredAction {
  account_id: string
  target_ref: string
  payload: Record<string, unknown>
}

export interface Connector {
  readonly provider: string
  readonly label: string
  status(): ConnectorStatus
  read(operation: string, params: Record<string, unknown>): Promise<unknown>
  action?(operation: string, params: Record<string, unknown>): ConnectorActionDraft
  deliver?(action: StoredAction): Promise<string>
}
