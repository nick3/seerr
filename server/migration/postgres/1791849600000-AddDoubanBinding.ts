import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDoubanBinding1791849600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "douban_binding" ("mediaType" varchar NOT NULL, "tmdbId" integer NOT NULL, "doubanId" varchar NOT NULL, "source" varchar NOT NULL, PRIMARY KEY ("mediaType", "tmdbId"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "douban_binding"`);
  }
}
