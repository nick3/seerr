import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import defineMessages from '@app/utils/defineMessages';
import type { DoubanRating } from '@server/api/rating/douban';
import type {
  DoubanBindingResponse,
  DoubanRatingResponse,
} from '@server/api/ratings';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.DoubanComments.BindingModal', {
  title: 'Bind Douban Title',
  help: 'Paste a Douban subject link or ID, then check the title and year. This binding applies to ratings and short reviews for everyone.',
  input: 'Douban subject link or ID',
  preview: 'Check Title',
  save: 'Save Binding',
  reset: 'Use Automatic Matching',
  cancel: 'Cancel',
  invalid: 'Enter a valid Douban subject link or numeric ID.',
  mismatch: 'This subject does not match the media type (movie or TV).',
  error: 'Douban is temporarily unavailable. Please try again.',
  saved: 'Current subject: {id}',
  manual: 'Manually bound',
  imdb: 'Matched by IMDb ID',
  name: 'Matched by title and year',
  year: 'Year: {year}',
});

function parseSubject(value: string): string | undefined {
  const input = value.trim();
  if (/^[1-9]\d{0,11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (
      url.origin === 'https://movie.douban.com' ||
      url.origin === 'http://movie.douban.com'
    ) {
      return url.pathname.match(/^\/subject\/([1-9]\d{0,11})\/?$/)?.[1];
    }
  } catch {
    /* Invalid input is shown inline. */
  }
}

const BindingModal = ({
  mediaType,
  tmdbId,
  onClose,
}: {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  onClose: () => void;
}) => {
  const intl = useIntl();
  const base = `/api/v1/${mediaType}/${tmdbId}`;
  const { data } = useSWR<DoubanBindingResponse>(`${base}/douban`);
  const { mutate } = useSWRConfig();
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<DoubanRating | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const showError = (e: unknown) =>
    setError(
      intl.formatMessage(
        axios.isAxiosError(e) && e.response?.status === 400
          ? messages.mismatch
          : messages.error
      )
    );
  const check = async () => {
    const id = parseSubject(input);
    setPreview(null);
    if (!id) {
      setError(intl.formatMessage(messages.invalid));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { data } = await axios.get<DoubanRatingResponse>(
        `${base}/douban/preview`,
        { params: { doubanId: id } }
      );
      setPreview(data.rating);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async (reset = false) => {
    if (!reset && !preview) return;
    setBusy(true);
    setError('');
    try {
      if (reset) await axios.delete(`${base}/douban`);
      else await axios.put(`${base}/douban`, { doubanId: preview?.id });
      // Clear both review sorts and the score, including inactive SWR entries.
      await mutate(
        (key) =>
          typeof key === 'string' &&
          (key === `${base}/douban` ||
            key === `${base}/ratings/douban` ||
            key.startsWith(`${base}/comments/douban`)),
        undefined,
        { revalidate: true }
      );
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={intl.formatMessage(messages.title)}
      onCancel={() => {
        if (!busy) onClose();
      }}
      cancelText={intl.formatMessage(messages.cancel)}
      cancelButtonProps={{ disabled: busy }}
      onOk={() => void save()}
      okDisabled={busy || !preview}
      okText={intl.formatMessage(messages.save)}
      onSecondary={data?.binding ? () => void save(true) : undefined}
      secondaryText={intl.formatMessage(messages.reset)}
      secondaryDisabled={busy}
      backgroundClickable={!busy}
    >
      <p className="mb-4">{intl.formatMessage(messages.help)}</p>
      {data?.binding && (
        <p className="mb-4 text-gray-400">
          {intl.formatMessage(messages.saved, { id: data.binding.doubanId })} ·{' '}
          {intl.formatMessage(
            data.binding.source === 'manual'
              ? messages.manual
              : data.binding.source === 'imdb'
                ? messages.imdb
                : messages.name
          )}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void check();
        }}
      >
        <label htmlFor="douban-subject" className="mb-2 block">
          {intl.formatMessage(messages.input)}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="douban-subject"
            type="text"
            value={input}
            maxLength={256}
            disabled={busy}
            className="min-w-0 flex-1 rounded-md border-gray-600 bg-gray-700 text-white"
            onChange={(event) => {
              setInput(event.target.value);
              setPreview(null);
              setError('');
            }}
          />
          <Button type="submit" disabled={busy || !input.trim()}>
            {intl.formatMessage(messages.preview)}
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-red-400">
          {error}
        </p>
      )}
      {preview && (
        <div role="status" className="mt-4 rounded-md bg-gray-900 p-4">
          <a
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-white hover:underline"
          >
            {preview.title}
          </a>
          <p className="mt-1 text-gray-400">
            {intl.formatMessage(messages.year, { year: String(preview.year) })}
            {preview.score !== null
              ? ` · ${Math.round(preview.score * 10)}%`
              : ''}
          </p>
        </div>
      )}
    </Modal>
  );
};

export default BindingModal;
