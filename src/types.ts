export type CouncilId = 'TW' | 'Sevenoaks' | 'Wealden';

export interface Application {
  council: CouncilId;
  applreference: string;
  address: string;
  description: string;
  datereceived?: string;    // ISO date YYYY-MM-DD
  datevalidated?: string;   // ISO date YYYY-MM-DD
  status?: string;
  decision?: string;
  decision_date?: string;   // ISO date YYYY-MM-DD
  appeal_decision?: string;
  appeal_date?: string;     // ISO date YYYY-MM-DD
  detailsurl: string;
  priority?: string | null;         // 'high' | 'medium' | 'low' | 'none' | null (unclassified)
  priority_reason?: string | null;  // one-sentence explanation from LLM
}
