import { Button, Drawer, DrawerContent } from '@bylinecrm/ui';
import { Link, useLocation, useNavigate } from 'react-router';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { CompanyRecord } from './CompanyRecord';
import { DealRecord } from './DealRecord';
import { PersonRecord } from './PersonRecord';
import { useMembersById } from '../../../api/queries';
import { RecordLoader } from './RecordPages';
import { OBJECT_LABEL, OPEN_PARAM, parseTarget, withOpen } from './targets';

/**
 * The record drawer over any workspace page: `?open=person:<id>` opens it, so a list row, a
 * palette result or a shared link all land on the same panel and a refresh keeps it. Esc or
 * the scrim closes it by removing the param; "Open full page" goes to the record's route.
 */
export function RecordDrawerHost() {
    const workspaceId = useWorkspaceId();
    const location = useLocation();
    const navigate = useNavigate();
    const target = parseTarget(new URLSearchParams(location.search).get(OPEN_PARAM));
    const members = useMembersById(workspaceId);
    const close = () =>
        navigate({ pathname: location.pathname, search: withOpen(location.search, null) }, { replace: true });

    if (!target) return null;
    const fullPage =
        target.type === 'person'
            ? paths.person(workspaceId, target.id)
            : target.type === 'company'
              ? paths.company(workspaceId, target.id)
              : paths.deal(workspaceId, target.id);

    return (
        <Drawer open onOpenChange={(open) => !open && close()}>
            <DrawerContent
                title={OBJECT_LABEL[target.type]}
                description={`${OBJECT_LABEL[target.type]} details`}
                actions={
                    <Button asChild size="sm" shape="square" variant="secondary">
                        <Link to={fullPage}>Open full page ↗</Link>
                    </Button>
                }
            >
                {target.type === 'person' && (
                    <RecordLoader
                        object="person"
                        id={target.id}
                        layout="drawer"
                        render={(p) => (
                            <PersonRecord workspaceId={workspaceId} person={p} layout="drawer" membersById={members} />
                        )}
                    />
                )}
                {target.type === 'company' && (
                    <RecordLoader
                        object="company"
                        id={target.id}
                        layout="drawer"
                        render={(c) => (
                            <CompanyRecord
                                workspaceId={workspaceId}
                                company={c}
                                layout="drawer"
                                membersById={members}
                            />
                        )}
                    />
                )}
                {target.type === 'opportunity' && (
                    <RecordLoader
                        object="opportunity"
                        id={target.id}
                        layout="drawer"
                        render={(d) => (
                            <DealRecord workspaceId={workspaceId} deal={d} layout="drawer" membersById={members} />
                        )}
                    />
                )}
            </DrawerContent>
        </Drawer>
    );
}
