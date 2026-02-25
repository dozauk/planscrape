export type CouncilId = 'TW' | 'Sevenoaks' | 'Wealden';

export interface Application {
  council: CouncilId;
  applreference: string;
  address: string;
  description: string;
  datereceived?: string;   // ISO date YYYY-MM-DD
  datevalidated?: string;  // ISO date YYYY-MM-DD
  status?: string;
  decision?: string;
  detailsurl: string;
}
