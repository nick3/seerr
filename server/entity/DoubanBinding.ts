import { Column, Entity, PrimaryColumn } from 'typeorm';

export type DoubanBindingSource = 'manual' | 'imdb' | 'title';

// Independent of Media: viewing a title must not create a requested-media row.
@Entity()
class DoubanBinding {
  @PrimaryColumn({ type: 'varchar' })
  public mediaType: 'movie' | 'tv';

  @PrimaryColumn({ type: 'integer' })
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public doubanId: string;

  @Column({ type: 'varchar' })
  public source: DoubanBindingSource;
}

export default DoubanBinding;
