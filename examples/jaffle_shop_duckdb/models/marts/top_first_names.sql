{# workbench:visual {"steps":[{"type":"source","ref":"customers"},{"type":"filter","match":"all","conditions":[{"column":"number_of_orders","op":"gt","value":"0"}]},{"type":"group","by":["first_name"],"aggs":[{"fn":"count","column":"","as":"row_count"},{"fn":"sum","column":"lifetime_value","as":"sum_lifetime_value"}]},{"type":"sort","by":[{"column":"sum_lifetime_value","desc":true}],"limit":"5"}],"materialized":"view"} #}
{{ config(materialized='view') }}

with source as (

    select * from {{ ref('customers') }}

),

filtered_2 as (

    select * from source
    where number_of_orders > 0

),

grouped_3 as (

    select
        first_name,
        count(*) as row_count,
        sum(lifetime_value) as sum_lifetime_value
    from filtered_2
    group by 1

),

sorted_4 as (

    select * from grouped_3
    order by sum_lifetime_value desc
    limit 5

)

select * from sorted_4
