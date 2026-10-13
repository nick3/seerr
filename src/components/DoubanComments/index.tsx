import Button from '@app/components/Common/Button';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowTopRightOnSquareIcon,
  HandThumbUpIcon,
} from '@heroicons/react/24/outline';
import { StarIcon } from '@heroicons/react/24/solid';
import type { DoubanCommentSort } from '@server/api/rating/douban';
import type { DoubanCommentsResponse } from '@server/api/ratings';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const BindingModal = dynamic(
  () => import('@app/components/DoubanComments/BindingModal')
);

const messages = defineMessages('components.DoubanComments', {
  title: 'Douban Short Reviews',
  binding: 'Bind Douban Title',
  hot: 'Popular',
  latest: 'Latest',
  total: '{count, plural, one {# short review} other {# short reviews}}',
  viewall: 'View on Douban',
  loading: 'Loading Douban short reviews…',
  empty: 'No short reviews are available yet.',
  unmatched: 'No matching Douban title was found.',
  error: 'Douban short reviews are temporarily unavailable.',
  retry: 'Try Again',
  anonymous: 'Anonymous',
  stars: '{rating} out of 5 stars',
  votes:
    '{count, plural, one {# person found this helpful} other {# people found this helpful}}',
});

const DoubanComments = ({
  mediaType,
  tmdbId,
}: {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
}) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const [showBinding, setShowBinding] = useState(false);
  const [sort, setSort] = useState<DoubanCommentSort>('new_score');
  const { data, error, isValidating, mutate } = useSWR<DoubanCommentsResponse>(
    `/api/v1/${mediaType}/${tmdbId}/comments/douban?sort=${sort}`,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      dedupingInterval: 60000,
    }
  );
  const headingId = `douban-comments-${mediaType}-${tmdbId}`;

  return (
    <section className="mt-8" aria-labelledby={headingId}>
      <Transition as="div" show={showBinding}>
        <BindingModal
          key={`${mediaType}:${tmdbId}`}
          mediaType={mediaType}
          tmdbId={tmdbId}
          onClose={() => setShowBinding(false)}
        />
      </Transition>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="heading flex items-center gap-2">
            <Image
              src="/douban.ico"
              alt=""
              width={24}
              height={24}
              unoptimized
            />
            {intl.formatMessage(messages.title)}
          </h2>
          {data?.subject && (
            <p className="mt-1 break-words text-sm text-gray-400">
              {data.subject.title} ·{' '}
              {intl.formatMessage(messages.total, { count: data.total })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasPermission(Permission.ADMIN) && (
            <Button
              buttonSize="sm"
              buttonType="ghost"
              onClick={() => setShowBinding(true)}
            >
              {intl.formatMessage(messages.binding)}
            </Button>
          )}
          <Button
            buttonSize="sm"
            buttonType={sort === 'new_score' ? 'primary' : 'ghost'}
            aria-pressed={sort === 'new_score'}
            onClick={() => setSort('new_score')}
          >
            {intl.formatMessage(messages.hot)}
          </Button>
          <Button
            buttonSize="sm"
            buttonType={sort === 'time' ? 'primary' : 'ghost'}
            aria-pressed={sort === 'time'}
            onClick={() => setSort('time')}
          >
            {intl.formatMessage(messages.latest)}
          </Button>
          {data?.subject && (
            <a
              href={`${data.subject.url}comments?sort=${sort}&status=P`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 inline-flex items-center gap-1 text-sm text-gray-300 hover:text-white hover:underline"
            >
              {intl.formatMessage(messages.viewall)}
              <ArrowTopRightOnSquareIcon
                className="h-4 w-4"
                aria-hidden="true"
              />
            </a>
          )}
        </div>
      </div>
      {error ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-700 bg-gray-800 p-4 text-sm text-gray-400"
        >
          <p>{intl.formatMessage(messages.error)}</p>
          <Button
            buttonSize="sm"
            disabled={isValidating}
            onClick={() => {
              void mutate();
            }}
          >
            {intl.formatMessage(messages.retry)}
          </Button>
        </div>
      ) : !data ? (
        <p role="status" className="py-4 text-sm text-gray-400">
          {intl.formatMessage(messages.loading)}
        </p>
      ) : data.comments.length === 0 ? (
        <p
          role="status"
          className="rounded-lg border border-gray-700 bg-gray-800 p-4 text-sm text-gray-400"
        >
          {intl.formatMessage(
            data.subject ? messages.empty : messages.unmatched
          )}
        </p>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {data.comments.map((comment) => (
            <li
              key={comment.id}
              className="min-w-0 rounded-lg border border-gray-700 bg-gray-800 p-4"
            >
              <article>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 break-words font-semibold text-gray-100 [overflow-wrap:anywhere]">
                    {comment.author || intl.formatMessage(messages.anonymous)}
                  </h3>
                  {comment.rating !== null && (
                    <span
                      role="img"
                      aria-label={intl.formatMessage(messages.stars, {
                        rating: comment.rating,
                      })}
                      className="flex shrink-0 gap-0.5"
                    >
                      {[1, 2, 3, 4, 5].map((star) => (
                        <StarIcon
                          key={star}
                          aria-hidden="true"
                          className={`h-4 w-4 ${star <= (comment.rating ?? 0) ? 'text-yellow-400' : 'text-gray-600'}`}
                        />
                      ))}
                    </span>
                  )}
                </div>
                <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-gray-300 [overflow-wrap:anywhere]">
                  {comment.content}
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
                  {comment.date ? (
                    <time dateTime={comment.date}>
                      {intl.formatDate(`${comment.date}T00:00:00Z`, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        timeZone: 'UTC',
                      })}
                    </time>
                  ) : (
                    <span />
                  )}
                  <span
                    className="inline-flex items-center gap-1"
                    title={intl.formatMessage(messages.votes, {
                      count: comment.votes,
                    })}
                  >
                    <HandThumbUpIcon className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only">
                      {intl.formatMessage(messages.votes, {
                        count: comment.votes,
                      })}
                    </span>
                    <span aria-hidden="true">
                      {intl.formatNumber(comment.votes)}
                    </span>
                  </span>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default DoubanComments;
