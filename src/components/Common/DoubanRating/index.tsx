import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import type { DoubanRatingResponse } from '@server/api/ratings';
import Image from 'next/image';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Common.DoubanRating', {
  label: 'Douban Rating',
  open: 'View {title} on Douban (opens in a new tab)',
});

const DoubanRating = ({
  mediaType,
  tmdbId,
}: {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
}) => {
  const intl = useIntl();
  const { data } = useSWR<DoubanRatingResponse>(
    `/api/v1/${mediaType}/${tmdbId}/ratings/douban`,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      dedupingInterval: 60000,
    }
  );
  if (!data?.rating || data.rating.score === null) return null;

  const { rating } = data;
  const score = Math.round(data.rating.score * 10);
  return (
    <Tooltip content={intl.formatMessage(messages.label)}>
      <a
        href={rating.url}
        className="media-rating"
        target="_blank"
        rel="noopener noreferrer"
        title={intl.formatMessage(messages.open, { title: rating.title })}
      >
        {/* Official favicon from https://www.douban.com/favicon.ico. */}
        <Image
          src="/douban.ico"
          alt="Douban"
          width={24}
          height={24}
          unoptimized
        />
        <span>{score}%</span>
      </a>
    </Tooltip>
  );
};

export default DoubanRating;
