-- Optional interest rate on a commitment, so Lydia can prioritize payoff
-- order by actual cost (debt avalanche) rather than just balance size.
alter table commitments add column if not exists interest_rate numeric;
