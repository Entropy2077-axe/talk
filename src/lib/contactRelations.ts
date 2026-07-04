import type { ContactRelationLabel } from '../types'

export type RelationSentiment = 'good' | 'neutral' | 'bad'

const SENTIMENT_BY_LABEL: Record<ContactRelationLabel, RelationSentiment> = {
  好朋友: 'good',
  损友: 'good',
  暧昧对象: 'good',
  恋人: 'good',
  家人: 'good',
  '前辈/同事': 'neutral',
  点头之交: 'neutral',
  看不顺眼: 'bad',
  对头: 'bad',
}

export function relationSentiment(label: ContactRelationLabel): RelationSentiment {
  return SENTIMENT_BY_LABEL[label] ?? 'neutral'
}

/** Whether a relationship is close/positive enough that the two might plausibly interact on each other's moments at all — bad ones never do. */
export function canReactToMoments(label: ContactRelationLabel): boolean {
  return relationSentiment(label) !== 'bad'
}
