"""drop institution domains and sso (sign-in works for any email instead)

Revision ID: 8408ad731311
Revises: 723df7923e42
Create Date: 2026-11-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8408ad731311'
down_revision: Union[str, None] = '723df7923e42'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('institution_domains', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_institution_domains_institution_id'))
        batch_op.drop_index(batch_op.f('ix_institution_domains_domain'))
    op.drop_table('institution_domains')
    op.drop_table('institution_sso')


def downgrade() -> None:
    op.create_table('institution_sso',
    sa.Column('institution_id', sa.String(length=32), nullable=False),
    sa.Column('label', sa.String(length=100), nullable=False),
    sa.Column('issuer', sa.String(length=500), nullable=False),
    sa.Column('client_id', sa.String(length=300), nullable=False),
    sa.Column('secret', sa.LargeBinary(), nullable=False),
    sa.Column('enforced', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['institution_id'], ['institutions.id'], name=op.f('fk_institution_sso_institution_id_institutions')),
    sa.PrimaryKeyConstraint('institution_id', name=op.f('pk_institution_sso'))
    )
    op.create_table('institution_domains',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('institution_id', sa.String(length=32), nullable=False),
    sa.Column('domain', sa.String(length=200), nullable=False),
    sa.Column('token', sa.String(length=64), nullable=False),
    sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['institution_id'], ['institutions.id'], name=op.f('fk_institution_domains_institution_id_institutions')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_institution_domains'))
    )
    with op.batch_alter_table('institution_domains', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_institution_domains_domain'), ['domain'], unique=True)
        batch_op.create_index(batch_op.f('ix_institution_domains_institution_id'), ['institution_id'], unique=False)
