-- Confirm default monthly token budget at 500,000 tokens.
-- At claude-sonnet-4-6 pricing this is ~$3-5/month depending on input/output ratio.
-- Hard cutoff is enforced in the kayzo-license plugin before_agent_start hook.
-- Free accounts are exempt from the cap.

alter table customers
  alter column monthly_token_budget set default 500000;

-- Ensure existing non-free customers are set to 500,000 if they were never updated.
-- Free accounts are left untouched.
update customers
set monthly_token_budget = 500000
where free_account = false
  and monthly_token_budget != 500000;
