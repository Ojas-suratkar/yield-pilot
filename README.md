# Yield Pilot

**Admission yield forecasting platform on Databricks.** Predicts which admitted students will enroll, rolls the probabilities up into a class-size forecast, and gives university leadership a daily view of the admit to deposit to enrollment funnel.

> Built as sole engineer at the CSULB Office of Institutional Research and Analytics. Source code is being prepared for public release and will be pushed here soon. Demo media will appear in the gallery below.

## Results

| Metric | Value |
|---|---|
| Fall 2026 class forecast vs. actual enrollment | **within 0.9%** |
| Prior production model on the same class | 18.7% overestimate |
| Admits used for training | **79,090** |
| Applicant records in the reporting pipelines | **500,000+** |
| Institutional reporting time | **cut 40%** |

## What it does

- **Forecasting model:** calibrated XGBoost yield model tuned with Optuna on Brier score, with isotonic calibration and chronological backtests so every evaluation mirrors how the model is used in production.
- **Per-college view:** forecasts by college with shrinkage toward trend, so small colleges do not swing on noise.
- **Data platform:** Databricks medallion tables (bronze, silver, gold) in Unity Catalog, joining PeopleSoft Campus Solutions with IRS ZIP income data and campus enrollment sources.
- **Release process:** champion and challenger models in the MLflow model registry, with promotion through a production alias.
- **Operations:** a nightly status job sequenced after upstream ingestion jobs, with missingness checks that catch stale source tables before they reach dashboards.
- **Secure access:** read-only OAuth machine-to-machine service principal, with secrets kept out of source and logs.

## Tech stack

Python, PySpark, SQL, Databricks, Unity Catalog, XGBoost, scikit-learn, Optuna, MLflow, PeopleSoft Campus Solutions, Next.js

## Demo

| Forecast dashboard | Pipeline and model registry |
|---|---|
| _Coming soon_ | _Coming soon_ |

## Author

**Ojas Suratkar** | [LinkedIn](https://www.linkedin.com/in/ojas-suratkar) | [Portfolio](https://ojas-suratkar.vercel.app)
