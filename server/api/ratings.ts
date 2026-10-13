import type { DoubanComments, DoubanRating } from '@server/api/rating/douban';
import { type IMDBRating } from '@server/api/rating/imdbRadarrProxy';
import { type RTRating } from '@server/api/rating/rottentomatoes';

export interface RatingResponse {
  rt?: RTRating;
  imdb?: IMDBRating;
}

export interface DoubanRatingResponse {
  rating: DoubanRating | null;
}

export interface DoubanCommentsResponse extends DoubanComments {
  subject: Pick<DoubanRating, 'id' | 'title' | 'url'> | null;
}

export interface DoubanBindingResponse {
  binding: { doubanId: string; source: 'manual' | 'imdb' | 'title' } | null;
}
