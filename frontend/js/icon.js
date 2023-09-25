"use strict";

import { library, dom } from "@fortawesome/fontawesome-svg-core";
import { faSearch, faToolbox, faHeart } from "@fortawesome/pro-solid-svg-icons";
import { faMessageSmile, faAt } from "@fortawesome/pro-regular-svg-icons";
import {
  faGlobe,
  faAngleDown,
  faMobile,
  faDesktop,
  faMonitorHeartRate,
} from "@fortawesome/pro-light-svg-icons";
import { faFilter, faSpinnerThird } from "@fortawesome/pro-duotone-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";

library.add(
  faSearch,
  faToolbox,
  faHeart,

  faMessageSmile,
  faAt,

  faGlobe,
  faAngleDown,
  faMobile,
  faDesktop,
  faMonitorHeartRate,

  faFilter,
  faSpinnerThird,

  faGithub
);
dom.watch();
