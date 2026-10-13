-- Typeahead and voice typos: also score the query against the start of each name ("gost" finds "Ghost escape").
-- Weighted below 1 so a prefix alone is never treated as an exact match.
create or replace function bjj_name_score(cand text, q text) returns real
language sql stable as $$
  select greatest(
    similarity(lower(cand), lower(q)),
    similarity(bjj_norm(cand), bjj_norm(q)),
    case when greatest(length(bjj_norm(cand)), length(bjj_norm(q))) = 0 then 0
         else 1 - levenshtein(left(bjj_norm(cand), 255), left(bjj_norm(q), 255))::real
                  / greatest(length(bjj_norm(cand)), length(bjj_norm(q)))
    end,
    0.9 * word_similarity(lower(q), lower(cand)),
    -- Start of the name, allowing one typo per four letters ("gost" ~ "ghos(t)", but "gho" is not "sho").
    (select coalesce(max(0.85 * (1 - x.d::real / x.n)), 0)
       from (select length(bjj_norm(q)) as n) nn
       cross join lateral (
         select nn.n, levenshtein(left(bjj_norm(cand), k), left(bjj_norm(q), 255)) as d
         from generate_series(greatest(nn.n - 1, 1), nn.n + 1) as k
       ) x
      where x.n >= 3 and x.d <= x.n / 4)
  )::real
$$;
