export interface Milestone {
  date: string;
  title?: string;
  description: string;
  longDescription?: string;
  category?: 'core' | 'automation' | 'learning' | 'social' | 'creative';
  status?: 'completed' | 'in-progress' | 'planned';
  icon?: string;
}

