# Recorded provider payloads

Hand-authored payloads in the shape Tank01 (RapidAPI) returns, used by
`SPORTS_DATA_PROVIDER=fixture` and by `npm run test:sync-data`. They are small
on purpose — four franchises, eleven players, two games — but they keep the
vendor's envelope (`{ statusCode, body }`), its string-typed numbers, its
object-keyed collections and its awkward cases:

- an offensive lineman (`pos: "OL"`) that the fantasy pool must skip, not choke on
- a kicker filed as `PK`, which normalises to `K`
- team defenses under their own node, keyed by team abbreviation
- one game with `gameTime_epoch` and one without, so both kickoff paths run
- no `opponent` on projections and no `pos` on box-score entries, because the
  live API sends neither — migration 0005 derives both from the database, and
  the fixtures have to reproduce the gap for those tests to mean anything
- points as a flat `fantasyPoints` on some rows and as
  `fantasyPointsDefault: {standard, halfPPR, PPR}` on another

To refresh from the real API (needs a key):

```bash
curl -s "https://$SPORTS_DATA_API_HOST/getNFLTeams?rosters=true" \
  -H "x-rapidapi-key: $SPORTS_DATA_API_KEY" \
  -H "x-rapidapi-host: $SPORTS_DATA_API_HOST" > getNFLTeams.rosters.json
```

File names are looked up most-specific-first —
`getNFLBoxScore.<gameID>.json`, `getNFLGamesForWeek.week<N>.json`,
`getNFLTeams.rosters.json`, then the plain `<endpoint>.json`
(see `lib/services/providers/fixtureTransport.ts`).
