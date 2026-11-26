-- depends_on: {{ ref('raw_payments') }}
with source as (
    select * from {{ source('jaffle', 'raw_payments') }}
)

select
    id as payment_id,
    order_id,
    payment_method,
    -- amounts are stored in cents
    amount / 100.0 as amount
from source
