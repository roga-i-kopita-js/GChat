FROM directus/directus:11.5.1

ENV MAX_RELATIONAL_DEPTH=13
#COPY extensions /directus/extensions
COPY migrations /directus/migrations
COPY snapshots/app.yml /directus/snapshots/app.yml
CMD ["/bin/sh", "-c", ": && node /directus/cli.js bootstrap && npx directus schema apply --yes snapshots/app.yml && node /directus/cli.js start"]
