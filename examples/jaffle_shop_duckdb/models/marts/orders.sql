{% set payment_methods = ['credit_card', 'coupon', 'bank_transfer', 'gift_card'] %}

with orders as (
    select * from {{ ref('stg_orders') }}
),

payments as (
    select * from {{ ref('stg_payments') }}
),

order_payments as (
    select
        order_id,
        {% for method in payment_methods -%}
        sum(case when payment_method = '{{ method }}' then amount else 0 end) as {{ method }}_amount,
        {% endfor -%}
        sum(amount) as total_amount
    from payments
    group by order_id
)

select
    orders.order_id,
    orders.customer_id,
    orders.order_date,
    orders.status,
    {% for method in payment_methods -%}
    order_payments.{{ method }}_amount,
    {% endfor -%}
    order_payments.total_amount as amount
from orders
left join order_payments using (order_id)
